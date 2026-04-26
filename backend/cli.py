"""
cli.py
------
League Replay Studio — CLI / Headless Mode (Feature 20)

Entry point when lrs.bat (or python app.py) is invoked with arguments.
Bypasses FastAPI and pywebview entirely — loads project from SQLite and
runs operations directly against the service layer.

Usage examples:
  lrs.bat                              # launches GUI (no args)
  lrs.bat --project 1 --highlights     # export highlight reel
  lrs.bat --project "My Race" --full-race --preset "Discord 720p"
  lrs.bat --project 1 --full-pipeline --upload
  lrs.bat --project 1 --analyse-only
  lrs.bat --help

Exit codes:
  0  success
  1  project error (not found, missing files, etc.)
  2  iRacing not running (when capture required but iRacing absent)
  3  encoding failed
"""

from __future__ import annotations

import argparse
import logging
import sys
import time
from pathlib import Path
from typing import Optional

# ── Logging setup ────────────────────────────────────────────────────────────
# Configured before any imports that use logger so handlers are in place.

def _configure_logging(verbose: bool, quiet: bool) -> None:
    """Configure logging to stderr based on verbosity flags."""
    if quiet:
        level = logging.ERROR
    elif verbose:
        level = logging.DEBUG
    else:
        level = logging.WARNING  # Only show warnings/errors in normal mode

    fmt = "%(levelname)s: %(message)s" if not verbose else "%(asctime)s %(name)s %(levelname)s: %(message)s"
    logging.basicConfig(stream=sys.stderr, level=level, format=fmt, force=True)


# ── CLI Exit Codes ───────────────────────────────────────────────────────────

class ExitCode:
    SUCCESS = 0
    PROJECT_ERROR = 1
    IRACING_NOT_RUNNING = 2
    ENCODING_FAILED = 3


# ── Progress helpers ─────────────────────────────────────────────────────────

def _print_progress(label: str, pct: float, eta_secs: Optional[float] = None, quiet: bool = False) -> None:
    """Print progress to stdout in the form: 'Encoding... 45% (ETA: 2:31)'"""
    if quiet:
        return
    if eta_secs is not None and eta_secs > 0:
        m, s = divmod(int(eta_secs), 60)
        eta_str = f" (ETA: {m}:{s:02d})"
    else:
        eta_str = ""
    print(f"\r{label} {pct:.0f}%{eta_str}", end="", flush=True)


def _print_done(quiet: bool = False) -> None:
    if not quiet:
        print()  # newline after progress line


# ── Argument Parser ──────────────────────────────────────────────────────────

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="lrs",
        description="League Replay Studio — CLI/Headless Mode",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Exit codes:
  0  success
  1  project error (not found, missing files)
  2  iRacing not running
  3  encoding failed

Examples:
  lrs --project 1 --highlights
  lrs --project "My Race" --full-race --preset "Discord 720p30"
  lrs --project 1 --full-pipeline --upload
  lrs --project 1 --analyse-only
  lrs --project 1 --highlights --output C:\\Videos\\out.mp4 --gpu 0 -v
        """,
    )

    # ── Target project ──────────────────────────────────────────────────────
    parser.add_argument(
        "--project",
        metavar="ID_OR_NAME",
        help="Project ID (integer) or project name to operate on",
    )

    # ── Project creation ────────────────────────────────────────────────────
    parser.add_argument(
        "--create-project",
        metavar="NAME",
        dest="create_project",
        help="Create a new project with this name if it does not already exist",
    )
    parser.add_argument(
        "--replay-file",
        metavar="PATH",
        dest="replay_file",
        help="Path to a .rpy replay file — used during --create-project or to override project replay",
    )
    parser.add_argument(
        "--from-active-session",
        action="store_true",
        dest="from_active_session",
        help="When creating a project, auto-populate metadata from the active iRacing session",
    )

    # ── Operations (mutually exclusive) ────────────────────────────────────
    ops = parser.add_mutually_exclusive_group()
    ops.add_argument(
        "--highlights",
        action="store_true",
        help="Export a highlight reel using the project's saved highlight config",
    )
    ops.add_argument(
        "--full-race",
        action="store_true",
        dest="full_race",
        help="Export the full race video without any EDL editing",
    )
    ops.add_argument(
        "--analyse-only",
        action="store_true",
        dest="analyse_only",
        help="Run race analysis only — no encoding",
    )
    ops.add_argument(
        "--full-pipeline",
        action="store_true",
        dest="full_pipeline",
        help="Run the complete automated pipeline (analysis→edit→capture→export→upload)",
    )

    # ── Options ─────────────────────────────────────────────────────────────
    parser.add_argument(
        "--preset",
        metavar="NAME",
        help='Pipeline preset name or ID',
    )
    parser.add_argument(
        "--output",
        metavar="PATH",
        help="Override the output file or directory path",
    )
    parser.add_argument(
        "--upload",
        action="store_true",
        help="Run the upload step after export (upload_to_youtube=True)",
    )
    parser.add_argument(
        "--gpu",
        metavar="INDEX",
        type=int,
        default=None,
        help="GPU index to use for encoding (0-based). Defaults to auto-select.",
    )
    parser.add_argument(
        "--non-interactive",
        action="store_true",
        dest="non_interactive",
        help=(
            "Headless mode: suppress all user-intervention steps. "
            "Steps that require manual action are skipped with a warning. "
            "Fails immediately on critical errors instead of pausing."
        ),
    )

    # ── Execution-path step toggles (--full-pipeline only) ───────────────────
    step_toggles = parser.add_argument_group(
        "execution path",
        "Control which pipeline steps run.  Only applies to --full-pipeline.",
    )
    step_toggles.add_argument(
        "--skip-capture",
        action="store_true",
        dest="skip_capture",
        help="Skip the capture step (use an existing video file)",
    )
    step_toggles.add_argument(
        "--skip-analysis",
        action="store_true",
        dest="skip_analysis",
        help="Skip event analysis (use existing analysis results)",
    )
    step_toggles.add_argument(
        "--skip-compose",
        action="store_true",
        dest="skip_compose",
        help="Skip the composition / overlay step",
    )
    step_toggles.add_argument(
        "--skip-export",
        action="store_true",
        dest="skip_export",
        help="Skip the final export / encode step",
    )
    step_toggles.add_argument(
        "--skip-edit",
        action="store_true",
        dest="skip_edit",
        help="Disable automatic highlight selection (auto_edit=False)",
    )

    # ── Verbosity ────────────────────────────────────────────────────────────
    verbosity = parser.add_mutually_exclusive_group()
    verbosity.add_argument(
        "-v",
        "--verbose",
        action="store_true",
        help="Enable verbose debug logging",
    )
    verbosity.add_argument(
        "-q",
        "--quiet",
        action="store_true",
        help="Suppress all output except errors",
    )

    return parser


# ── Project resolution ────────────────────────────────────────────────────────

def _resolve_project(project_arg: str) -> Optional[dict]:
    """Resolve a project by ID or name. Returns project dict or None."""
    from server.services.project_service import ProjectService
    svc = ProjectService()

    # Try integer ID first
    try:
        project_id = int(project_arg)
        return svc.get_project(project_id)
    except ValueError:
        pass

    # Search by name (exact, then case-insensitive)
    all_projects = svc.list_projects(search=project_arg)
    for proj in all_projects:
        if proj["name"].lower() == project_arg.lower():
            return svc.get_project(proj["id"])

    return None


def _create_project_from_replay(
    name: str,
    replay_file: str,
    quiet: bool = False,
) -> Optional[dict]:
    """Create a project from an explicit replay file path."""
    from server.services.project_service import ProjectService

    if not Path(replay_file).exists():
        print(f"ERROR: Replay file not found: {replay_file}", file=sys.stderr)
        return None

    svc = ProjectService()
    if not quiet:
        print(f"Creating project '{name}' from replay: {replay_file}")

    try:
        project = svc.create_project(
            name=name,
            replay_file=replay_file,
        )
        if not quiet:
            print(f"  Created project #{project['id']}: {project['name']}")
        return project
    except Exception as exc:
        print(f"ERROR: Could not create project: {exc}", file=sys.stderr)
        return None


def _create_project_from_active_session(
    name: str,
    quiet: bool = False,
) -> Optional[dict]:
    """Create a project using metadata from the active iRacing session."""
    from server.services.iracing_bridge import bridge as iracing_bridge
    from server.services.project_service import ProjectService

    if not iracing_bridge.is_connected:
        print("ERROR: iRacing is not connected. Cannot auto-populate from active session.", file=sys.stderr)
        return None

    session_data = iracing_bridge.session_data
    track_name = session_data.get("track_name", "")
    session_type = session_data.get("session_type", "")
    drivers = [d for d in session_data.get("drivers", []) if not d.get("is_spectator", False)]
    num_drivers = len(drivers)

    if not quiet:
        print(f"Auto-populating from active iRacing session:")
        print(f"  Track:    {track_name or 'unknown'}")
        print(f"  Type:     {session_type or 'unknown'}")
        print(f"  Drivers:  {num_drivers}")
        print(f"Creating project '{name}'...")

    svc = ProjectService()
    try:
        project = svc.create_project(
            name=name,
            track_name=track_name,
            session_type=session_type,
            num_drivers=num_drivers,
        )
        if not quiet:
            print(f"  Created project #{project['id']}: {project['name']}")
        return project
    except Exception as exc:
        print(f"ERROR: Could not create project: {exc}", file=sys.stderr)
        return None


def _resolve_or_create_project(
    project_arg: Optional[str],
    create_name: Optional[str],
    replay_file: Optional[str],
    from_active_session: bool,
    quiet: bool,
) -> Optional[dict]:
    """Resolve or create a project depending on CLI flags.

    Priority:
      1. If --create-project NAME is given and the project already exists by
         that name, return the existing project (idempotent).
      2. If --create-project NAME is given and the project doesn't exist:
         a. If --replay-file provided  → create from replay.
         b. If --from-active-session  → create from active iRacing session.
         c. Otherwise fail with a clear message.
      3. If only --project is given, resolve by ID or name (no creation).
    """
    name = create_name or project_arg

    if create_name:
        # Try to find existing project with this name first (idempotent)
        existing = _resolve_project(create_name)
        if existing:
            if not quiet:
                print(f"Project '{create_name}' already exists (#{existing['id']}), using it.")
            return existing

        # Create new project
        if replay_file:
            return _create_project_from_replay(create_name, replay_file, quiet)
        elif from_active_session:
            return _create_project_from_active_session(create_name, quiet)
        else:
            print(
                f"ERROR: --create-project requires either --replay-file PATH "
                f"or --from-active-session.",
                file=sys.stderr,
            )
            return None

    # No create flag — just resolve existing project
    if project_arg:
        return _resolve_project(project_arg)

    return None


# ── Operations ────────────────────────────────────────────────────────────────

def _run_analyse_only(project: dict, quiet: bool, verbose: bool) -> int:
    """Run analysis on the project's replay file."""
    import asyncio
    from server.services.replay_analysis import AnalysisService

    if not quiet:
        print(f"Analysing project '{project['name']}'...")

    replay_file = project.get("replay_file") or project.get("files", {}).get("replay")
    if not replay_file or not Path(replay_file).exists():
        print(f"ERROR: No replay file found for project '{project['name']}'", file=sys.stderr)
        return ExitCode.PROJECT_ERROR

    svc = AnalysisService()

    def _progress_cb(pct: float, msg: str = "") -> None:
        _print_progress(f"Analysing{'...' if not msg else ' ' + msg}", pct, quiet=quiet)

    try:
        result = asyncio.run(svc.run_analysis(project["id"], replay_file, progress_callback=_progress_cb))
        _print_done(quiet)
        if not result.get("success"):
            print(f"ERROR: Analysis failed: {result.get('error', 'Unknown error')}", file=sys.stderr)
            return ExitCode.PROJECT_ERROR
        if not quiet:
            event_count = result.get("event_count", 0)
            print(f"Analysis complete. Found {event_count} events.")
        return ExitCode.SUCCESS
    except Exception as exc:
        _print_done(quiet)
        print(f"ERROR: Analysis failed: {exc}", file=sys.stderr)
        return ExitCode.PROJECT_ERROR


def _run_encode(
    project: dict,
    job_type: str,
    preset_name: Optional[str],
    output_override: Optional[str],
    gpu_index: Optional[int],
    quiet: bool,
    verbose: bool,
) -> int:
    """Run an encoding job synchronously, polling for completion."""
    import time
    from server.services.encoding_service import EncodingService, EncodingState

    if not quiet:
        label = "highlight reel" if job_type == "highlight" else "full race"
        print(f"Encoding {label} for project '{project['name']}'...")

    svc = EncodingService()

    # Resolve input file
    files = project.get("files") or {}
    input_file = files.get("replay") or project.get("replay_file")
    if not input_file or not Path(input_file).exists():
        print(f"ERROR: No replay video found for project '{project['name']}'", file=sys.stderr)
        return ExitCode.PROJECT_ERROR

    # Resolve preset
    preset_id = "1080p"  # default
    if preset_name:
        all_presets = svc.get_presets()
        matched = next(
            (p for p in all_presets
             if p.get("id", "").lower() == preset_name.lower()
             or p.get("name", "").lower() == preset_name.lower()),
            None,
        )
        if not matched:
            print(f"ERROR: Unknown preset '{preset_name}'. Available: {', '.join(p.get('name', p.get('id', '')) for p in all_presets)}", file=sys.stderr)
            return ExitCode.PROJECT_ERROR
        preset_id = matched["id"]

    # Resolve output directory
    output_dir = output_override or str(Path(input_file).parent)

    # Build EDL for highlight reel
    edl: Optional[list] = None
    if job_type == "highlight":
        from server.services.project_service import ProjectService
        proj_svc = ProjectService()
        project_files = proj_svc.get_project_files(project["id"])
        if project_files:
            edl = project_files.get("edl") or project_files.get("highlights")
        if not edl:
            if not quiet:
                print("WARNING: No highlight EDL found, exporting full video instead.", file=sys.stderr)
            job_type = "full"

    # Submit job
    result = svc.submit_job(
        project_id=project["id"],
        input_file=input_file,
        output_dir=output_dir,
        preset_id=preset_id,
        edl=edl,
        job_type=job_type,
    )

    if not result.get("success"):
        print(f"ERROR: Failed to start encoding: {result.get('error', 'Unknown error')}", file=sys.stderr)
        return ExitCode.ENCODING_FAILED

    job_id = result["job"]["job_id"]

    # Poll for completion
    start_time = time.monotonic()
    last_pct = -1.0
    while True:
        job = svc.get_job(job_id)
        if not job:
            print("ERROR: Encoding job disappeared unexpectedly.", file=sys.stderr)
            return ExitCode.ENCODING_FAILED

        pct = float(job.get("progress", 0))
        state = job.get("state", "")

        if pct != last_pct:
            elapsed = time.monotonic() - start_time
            eta: Optional[float] = None
            if pct > 0:
                eta = (elapsed / pct) * (100 - pct)
            _print_progress("Encoding...", pct, eta, quiet=quiet)
            last_pct = pct

        if state == EncodingState.COMPLETED:
            _print_done(quiet)
            if not quiet:
                print(f"Encoding complete: {job.get('output_file', '')}")
            return ExitCode.SUCCESS

        if state in (EncodingState.ERROR, EncodingState.CANCELLED):
            _print_done(quiet)
            print(f"ERROR: Encoding {state}: {job.get('error', '')}", file=sys.stderr)
            return ExitCode.ENCODING_FAILED

        time.sleep(0.5)


def _run_full_pipeline(
    project: dict,
    upload: bool,
    preset_name: Optional[str],
    output_override: Optional[str],
    skip_capture: bool = False,
    skip_analysis: bool = False,
    skip_compose: bool = False,
    skip_export: bool = False,
    skip_edit: bool = False,
    non_interactive: bool = False,
    quiet: bool = False,
    verbose: bool = False,
) -> int:
    """Run the full automated pipeline synchronously."""
    import time
    from server.services.pipeline_service import PipelineService, PipelineState

    if not quiet:
        print(f"Running full pipeline for project '{project['name']}'...")

    svc = PipelineService()

    # Resolve preset ID
    pipeline_preset_id: Optional[str] = None
    if preset_name:
        presets = svc.list_presets()
        matched = next(
            (p for p in presets
             if p.get("id", "").lower() == preset_name.lower()
             or p.get("name", "").lower() == preset_name.lower()),
            None,
        )
        if not matched:
            available = ", ".join(p.get("name", p.get("id", "")) for p in presets)
            print(f"ERROR: Unknown pipeline preset '{preset_name}'. Available: {available}", file=sys.stderr)
            return ExitCode.PROJECT_ERROR
        pipeline_preset_id = matched["id"]

    # Build runtime overrides — execution path flags + other CLI options
    runtime: dict = {}
    if skip_capture:
        runtime["skip_capture"] = True
    if skip_analysis:
        runtime["skip_analysis"] = True
    if skip_compose:
        runtime["skip_compose"] = True
    if skip_export:
        runtime["skip_export"] = True
    if skip_edit:
        runtime["auto_edit"] = False
    if upload:
        runtime["upload_to_youtube"] = True
    if output_override:
        runtime["output_dir"] = output_override
    if non_interactive:
        runtime["non_interactive"] = True
        runtime["failure_action"] = "abort"

    result = svc.start(
        project_id=project["id"],
        preset_id=pipeline_preset_id,
        config=runtime if runtime else None,
    )

    if not result.get("run"):
        print(f"ERROR: Failed to start pipeline: {result.get('error', 'Unknown error')}", file=sys.stderr)
        return ExitCode.PROJECT_ERROR

    run_id = result["run"]["run_id"]
    last_step = ""
    last_pct = -1.0

    # Poll for completion
    while True:
        status = svc.status
        run = status.get("run")
        if not run or run.get("run_id") != run_id:
            if status.get("run") is None and last_pct >= 100:
                break
            time.sleep(0.5)
            continue

        state = run.get("state", "")
        current_step = run.get("current_step", "")
        steps = run.get("steps", {})

        # Compute overall progress
        completed = sum(
            1 for s in steps.values()
            if s.get("state") in ("completed", "skipped")
        )
        total = max(len(steps), 1)
        pct = (completed / total) * 100

        step_pct = 0.0
        if current_step and current_step in steps:
            step_pct = float(steps[current_step].get("progress", 0))

        if current_step != last_step or pct != last_pct:
            step_label = f" [{current_step}]" if current_step else ""
            _print_progress(f"Pipeline{step_label}...", pct, quiet=quiet)
            last_step = current_step
            last_pct = pct

        if state == PipelineState.COMPLETED:
            _print_done(quiet)
            if not quiet:
                print("Pipeline complete.")
            return ExitCode.SUCCESS

        if state == PipelineState.FAILED:
            _print_done(quiet)
            failed_steps = [
                f"{name}: {s.get('error', 'unknown')}"
                for name, s in steps.items()
                if s.get("state") == "failed"
            ]
            print(f"ERROR: Pipeline failed. {'; '.join(failed_steps)}", file=sys.stderr)
            return ExitCode.ENCODING_FAILED

        if state == PipelineState.CANCELLED:
            _print_done(quiet)
            print("ERROR: Pipeline was cancelled.", file=sys.stderr)
            return ExitCode.PROJECT_ERROR

        if state == PipelineState.WAITING_INTERVENTION:
            _print_done(quiet)
            print("ERROR: Pipeline paused waiting for intervention. Run again with --full-pipeline after fixing.", file=sys.stderr)
            return ExitCode.ENCODING_FAILED

        time.sleep(0.5)

    return ExitCode.SUCCESS


# ── Main CLI entrypoint ───────────────────────────────────────────────────────

def main(argv: Optional[list[str]] = None) -> int:
    """
    Main CLI entry point.

    Returns an exit code (0=success, 1=project error, 2=iRacing, 3=encoding failed).
    """
    parser = build_parser()
    args = parser.parse_args(argv)

    _configure_logging(args.verbose, args.quiet)

    # ── Check if this is actually a CLI invocation ─────────────────────────
    has_project = bool(args.project or getattr(args, "create_project", None))
    if not has_project:
        # No project and no operation → not CLI mode (caller should launch GUI)
        return -1  # Special: not a CLI invocation

    if not quiet_mode(args):
        from version import APP_NAME, __version__
        print(f"{APP_NAME} v{__version__} — CLI Mode")

    # ── Resolve / create project ───────────────────────────────────────────
    project = _resolve_or_create_project(
        project_arg=args.project,
        create_name=getattr(args, "create_project", None),
        replay_file=getattr(args, "replay_file", None),
        from_active_session=getattr(args, "from_active_session", False),
        quiet=args.quiet,
    )
    if not project:
        print(
            f"ERROR: Project not found: '{args.project or getattr(args, 'create_project', '')}'",
            file=sys.stderr,
        )
        return ExitCode.PROJECT_ERROR

    # ── Dispatch operation ──────────────────────────────────────────────────
    if args.analyse_only:
        return _run_analyse_only(project, args.quiet, args.verbose)

    if args.full_pipeline:
        return _run_full_pipeline(
            project=project,
            upload=args.upload,
            preset_name=args.preset,
            output_override=args.output,
            skip_capture=getattr(args, "skip_capture", False),
            skip_analysis=getattr(args, "skip_analysis", False),
            skip_compose=getattr(args, "skip_compose", False),
            skip_export=getattr(args, "skip_export", False),
            skip_edit=getattr(args, "skip_edit", False),
            non_interactive=getattr(args, "non_interactive", False),
            quiet=args.quiet,
            verbose=args.verbose,
        )

    if args.highlights:
        rc = _run_encode(
            project=project,
            job_type="highlight",
            preset_name=args.preset,
            output_override=args.output,
            gpu_index=args.gpu,
            quiet=args.quiet,
            verbose=args.verbose,
        )
    elif args.full_race:
        rc = _run_encode(
            project=project,
            job_type="full",
            preset_name=args.preset,
            output_override=args.output,
            gpu_index=args.gpu,
            quiet=args.quiet,
            verbose=args.verbose,
        )
    else:
        # --project specified but no operation given — show project info
        if not args.quiet:
            print(f"Project: {project['name']} (ID: {project['id']})")
            print(f"  Status:    {project.get('step', 'unknown')}")
            print(f"  Replay:    {project.get('replay_file') or 'not set'}")
            print()
            print("Tip: Use --highlights, --full-race, --analyse-only, or --full-pipeline")
        return ExitCode.SUCCESS

    # Optional YouTube upload after successful encoding
    if rc == ExitCode.SUCCESS and args.upload and not args.full_pipeline:
        rc = _run_upload(project, args.quiet, args.verbose)

    return rc


def quiet_mode(args: argparse.Namespace) -> bool:
    return getattr(args, "quiet", False)


def _run_upload(project: dict, quiet: bool, verbose: bool) -> int:
    """Upload the latest export from this project to YouTube."""
    from server.services.encoding_service import EncodingService
    from server.services.youtube_service import YouTubeService

    if not quiet:
        print("Uploading to YouTube...")

    enc_svc = EncodingService()
    exports = enc_svc.get_completed_exports()
    # Find most recent export for this project
    project_exports = [e for e in exports if e.get("project_id") == project["id"]]
    if not project_exports:
        print("ERROR: No completed export found for this project.", file=sys.stderr)
        return ExitCode.PROJECT_ERROR

    latest = max(project_exports, key=lambda e: e.get("completed_at", 0))
    output_file = latest.get("output_file")
    if not output_file or not Path(output_file).exists():
        print("ERROR: Export file not found on disk.", file=sys.stderr)
        return ExitCode.PROJECT_ERROR

    yt_svc = YouTubeService()
    if not yt_svc.is_connected:
        print("ERROR: YouTube is not connected. Connect via Settings → YouTube.", file=sys.stderr)
        return ExitCode.PROJECT_ERROR

    import asyncio
    import time

    result = asyncio.run(yt_svc.start_upload(
        file_path=output_file,
        title=project.get("name", "Race Highlights"),
        description="",
        tags=[],
        privacy="unlisted",
        project_id=project["id"],
    ))

    if not result.get("success"):
        print(f"ERROR: Upload failed: {result.get('error', 'Unknown')}", file=sys.stderr)
        return ExitCode.ENCODING_FAILED

    job_id = result["job"]["job_id"]

    # Poll for upload completion
    last_pct = -1.0
    while True:
        status = yt_svc.get_upload_status()
        active = status.get("active_upload")
        if not active or active.get("job_id") != job_id:
            break

        pct = float(active.get("progress", 0))
        if pct != last_pct:
            _print_progress("Uploading...", pct, quiet=quiet)
            last_pct = pct

        upload_state = active.get("state", "")
        if upload_state == "completed":
            _print_done(quiet)
            if not quiet:
                print(f"Upload complete: {active.get('video_url', '')}")
            return ExitCode.SUCCESS

        if upload_state in ("error", "failed"):
            _print_done(quiet)
            print(f"ERROR: Upload failed: {active.get('error', '')}", file=sys.stderr)
            return ExitCode.ENCODING_FAILED

        time.sleep(1.0)

    _print_done(quiet)
    if not quiet:
        print("Upload complete.")
    return ExitCode.SUCCESS
