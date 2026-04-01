"""
test_career_stats.py
--------------------
Unit tests for CareerStatsService.

Uses an in-memory SQLite database so no file I/O is required.
The iRacing API fetch is replaced with a mock to keep tests fast
and offline.
"""

from __future__ import annotations

import asyncio
import sqlite3
from datetime import datetime, timedelta, timezone
from typing import Optional
from unittest.mock import AsyncMock, patch

import pytest

from server.services.career_stats_service import CareerStatsService


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_service(tmp_path) -> CareerStatsService:
    """Return a CareerStatsService backed by a temp file database."""
    svc = CareerStatsService(db_path=tmp_path / "career_stats.db", batch_size=5, poll_interval_seconds=0.01)
    svc.open()
    return svc


def _fake_stats(cust_id: int) -> dict:
    return {
        "display_name": f"Driver {cust_id}",
        "oval_irating": 2000 + cust_id,
        "road_irating": 1800 + cust_id,
        "dirt_oval_irating": None,
        "dirt_road_irating": None,
        "oval_sr": 399,
        "road_sr": 450,
        "dirt_oval_sr": None,
        "dirt_road_sr": None,
        "license_class": "A",
        "license_level": 4,
        "total_starts": 100,
        "total_wins": 5,
        "total_top5": 20,
        "total_poles": 3,
        "total_laps_led": 150,
    }


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture()
def svc(tmp_path):
    service = _make_service(tmp_path)
    yield service
    service.close()


# ---------------------------------------------------------------------------
# enqueue
# ---------------------------------------------------------------------------

class TestEnqueue:
    def test_enqueue_new_drivers_returns_count(self, svc):
        inserted = svc.enqueue([111, 222, 333])
        assert inserted == 3

    def test_enqueue_duplicate_is_idempotent(self, svc):
        svc.enqueue([111])
        inserted = svc.enqueue([111])
        assert inserted == 0

    def test_enqueue_mixed_new_and_existing(self, svc):
        svc.enqueue([111])
        inserted = svc.enqueue([111, 222])
        assert inserted == 1

    def test_enqueue_empty_list_returns_zero(self, svc):
        assert svc.enqueue([]) == 0

    def test_enqueue_preserves_existing_hydration_state(self, svc):
        svc.enqueue([111])
        # Manually set hydration_count and last_updated
        svc._conn.execute(
            "UPDATE career_stats SET hydration_count = 3, last_updated = '2025-01-01T00:00:00.000Z' WHERE cust_id = 111"
        )
        svc._conn.commit()
        svc.enqueue([111])  # should be a no-op
        row = svc.get_stats(111)
        assert row["hydration_count"] == 3


# ---------------------------------------------------------------------------
# get_next_batch / priority ordering
# ---------------------------------------------------------------------------

class TestPriorityOrdering:
    def test_never_hydrated_comes_first(self, svc):
        """Drivers with last_updated IS NULL must appear before hydrated ones."""
        svc.enqueue([1, 2, 3])
        # Hydrate driver 2 first (making it "already hydrated")
        svc._conn.execute(
            "UPDATE career_stats SET hydration_count = 1, last_updated = '2025-06-01T00:00:00.000Z' WHERE cust_id = 2"
        )
        svc._conn.commit()

        batch = svc.get_next_batch(limit=3)
        # Driver 2 is already hydrated — it must appear after 1 and 3
        never_hydrated = batch[:2]
        assert 2 not in never_hydrated

    def test_lower_hydration_count_before_higher(self, svc):
        """Among hydrated drivers, fewer hydrations = higher priority."""
        svc.enqueue([10, 20, 30])
        now = datetime.now(timezone.utc)
        # All drivers hydrated at the same time, but different counts
        for cust_id, count in [(10, 5), (20, 1), (30, 3)]:
            svc._conn.execute(
                "UPDATE career_stats SET hydration_count = ?, last_updated = ? WHERE cust_id = ?",
                (count, now.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z", cust_id),
            )
        svc._conn.commit()

        batch = svc.get_next_batch(limit=3)
        assert batch == [20, 30, 10]  # ascending hydration_count

    def test_oldest_last_updated_before_newer(self, svc):
        """Among drivers with equal hydration_count, oldest last_updated first."""
        svc.enqueue([100, 200, 300])
        base = datetime(2025, 1, 1, tzinfo=timezone.utc)
        dates = {100: base + timedelta(days=10), 200: base, 300: base + timedelta(days=5)}
        for cust_id, ts in dates.items():
            svc._conn.execute(
                "UPDATE career_stats SET hydration_count = 1, last_updated = ? WHERE cust_id = ?",
                (ts.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z", cust_id),
            )
        svc._conn.commit()

        batch = svc.get_next_batch(limit=3)
        assert batch == [200, 300, 100]  # oldest → newest

    def test_never_hydrated_before_low_count(self, svc):
        """NULL last_updated beats any non-zero hydration_count."""
        svc.enqueue([1, 2])
        svc._conn.execute(
            "UPDATE career_stats SET hydration_count = 1, last_updated = '2020-01-01T00:00:00.000Z' WHERE cust_id = 2"
        )
        svc._conn.commit()

        batch = svc.get_next_batch(limit=2)
        assert batch[0] == 1  # never hydrated first

    def test_get_next_batch_respects_limit(self, svc):
        svc.enqueue([1, 2, 3, 4, 5])
        batch = svc.get_next_batch(limit=3)
        assert len(batch) == 3

    def test_empty_queue_returns_empty_list(self, svc):
        assert svc.get_next_batch() == []


# ---------------------------------------------------------------------------
# hydrate
# ---------------------------------------------------------------------------

class TestHydrate:
    @pytest.mark.asyncio
    async def test_hydrate_updates_stats_and_increments_count(self, svc):
        svc.enqueue([42])
        with patch.object(svc, "_fetch_from_iracing", new=AsyncMock(return_value=_fake_stats(42))):
            success = await svc.hydrate(42)

        assert success is True
        row = svc.get_stats(42)
        assert row["display_name"] == "Driver 42"
        assert row["oval_irating"] == 2042
        assert row["hydration_count"] == 1
        assert row["last_updated"] is not None

    @pytest.mark.asyncio
    async def test_hydrate_increments_count_on_repeated_call(self, svc):
        svc.enqueue([42])
        with patch.object(svc, "_fetch_from_iracing", new=AsyncMock(return_value=_fake_stats(42))):
            await svc.hydrate(42)
            await svc.hydrate(42)

        row = svc.get_stats(42)
        assert row["hydration_count"] == 2

    @pytest.mark.asyncio
    async def test_hydrate_returns_false_when_fetch_returns_none(self, svc):
        svc.enqueue([99])
        with patch.object(svc, "_fetch_from_iracing", new=AsyncMock(return_value=None)):
            result = await svc.hydrate(99)
        assert result is False

    @pytest.mark.asyncio
    async def test_hydrate_returns_false_on_exception(self, svc):
        svc.enqueue([77])
        with patch.object(svc, "_fetch_from_iracing", new=AsyncMock(side_effect=RuntimeError("API down"))):
            result = await svc.hydrate(77)
        assert result is False

    @pytest.mark.asyncio
    async def test_hydrate_does_not_corrupt_db_on_failure(self, svc):
        svc.enqueue([55])
        with patch.object(svc, "_fetch_from_iracing", new=AsyncMock(side_effect=RuntimeError("oops"))):
            await svc.hydrate(55)
        row = svc.get_stats(55)
        assert row["hydration_count"] == 0
        assert row["last_updated"] is None


# ---------------------------------------------------------------------------
# queue_depth
# ---------------------------------------------------------------------------

class TestQueueDepth:
    def test_empty_db(self, svc):
        depth = svc.queue_depth()
        assert depth == {"total": 0, "pending_hydration": 0, "stale": 0}

    def test_all_pending(self, svc):
        svc.enqueue([1, 2, 3])
        depth = svc.queue_depth()
        assert depth["total"] == 3
        assert depth["pending_hydration"] == 3

    def test_stale_count(self, svc):
        svc.enqueue([1, 2])
        old_ts = (datetime.now(timezone.utc) - timedelta(days=2)).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
        recent_ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
        svc._conn.execute(
            "UPDATE career_stats SET hydration_count=1, last_updated=? WHERE cust_id=1",
            (old_ts,),
        )
        svc._conn.execute(
            "UPDATE career_stats SET hydration_count=1, last_updated=? WHERE cust_id=2",
            (recent_ts,),
        )
        svc._conn.commit()
        depth = svc.queue_depth()
        assert depth["stale"] == 1


# ---------------------------------------------------------------------------
# list_stats
# ---------------------------------------------------------------------------

class TestListStats:
    def test_returns_all_rows(self, svc):
        svc.enqueue([1, 2, 3])
        rows = svc.list_stats()
        assert len(rows) == 3

    def test_pagination(self, svc):
        svc.enqueue(list(range(1, 11)))
        page1 = svc.list_stats(limit=4, offset=0)
        page2 = svc.list_stats(limit=4, offset=4)
        assert len(page1) == 4
        assert len(page2) == 4
        assert {r["cust_id"] for r in page1}.isdisjoint({r["cust_id"] for r in page2})

    def test_list_stats_ordered_by_priority(self, svc):
        """Rows returned by list_stats follow the same priority order as get_next_batch."""
        svc.enqueue([1, 2])
        svc._conn.execute(
            "UPDATE career_stats SET hydration_count=1, last_updated='2025-01-01T00:00:00.000Z' WHERE cust_id=2"
        )
        svc._conn.commit()
        rows = svc.list_stats()
        assert rows[0]["cust_id"] == 1  # never hydrated first
