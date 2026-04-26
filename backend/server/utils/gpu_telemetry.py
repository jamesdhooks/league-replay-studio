"""
gpu_telemetry.py
----------------
Real-time NVIDIA GPU telemetry polling service.

Queries nvidia-smi for actual GPU utilization, memory usage, temperature, and power draw
during active encoding jobs. Falls back gracefully if nvidia-smi is unavailable or GPU
is not NVIDIA.

Usage:
    telemetry = GPUTelemetry()
    stats = telemetry.poll(gpu_index=0)
    if stats:
        print(f"GPU {stats['gpu_index']}: {stats['utilization']}% utilization")
"""

from __future__ import annotations

import json
import subprocess
import logging
import re
from dataclasses import dataclass
from typing import Optional

logger = logging.getLogger(__name__)


@dataclass
class GPUStats:
    """Real-time GPU telemetry snapshot."""
    gpu_index: int
    utilization: int  # 0-100
    memory_used_mb: int
    memory_total_mb: int
    temperature_c: int
    power_draw_w: Optional[float]  # May be N/A
    
    def to_dict(self) -> dict:
        """Serialize to dict for JSON transmission."""
        return {
            "gpu_index": self.gpu_index,
            "utilization": self.utilization,
            "memory_used_mb": self.memory_used_mb,
            "memory_total_mb": self.memory_total_mb,
            "memory_percent": round(100 * self.memory_used_mb / self.memory_total_mb) if self.memory_total_mb > 0 else 0,
            "temperature_c": self.temperature_c,
            "power_draw_w": self.power_draw_w,
        }


class GPUTelemetry:
    """
    NVIDIA GPU telemetry poller using nvidia-smi.
    
    Safe to poll frequently (50-100ms intervals); nvidia-smi execution is fast.
    Handles missing/non-NVIDIA GPUs gracefully with None return.
    """
    
    def __init__(self):
        """Initialize telemetry poller."""
        self._available = self._check_nvidia_smi()
    
    def _check_nvidia_smi(self) -> bool:
        """Check if nvidia-smi is available in PATH."""
        try:
            result = subprocess.run(
                ["nvidia-smi", "--version"],
                capture_output=True,
                timeout=2,
                text=True
            )
            available = result.returncode == 0
            if available:
                logger.info("✓ nvidia-smi available for GPU telemetry")
            else:
                logger.debug("nvidia-smi not available (non-NVIDIA GPU?)")
            return available
        except (FileNotFoundError, subprocess.TimeoutExpired):
            logger.debug("nvidia-smi not found in PATH")
            return False
    
    def poll(self, gpu_index: int = 0) -> Optional[GPUStats]:
        """
        Poll GPU telemetry for specified GPU index.
        
        Args:
            gpu_index: NVIDIA GPU index (0, 1, ...)
        
        Returns:
            GPUStats if successful, None if nvidia-smi unavailable or query fails.
        """
        if not self._available:
            return None
        
        try:
            # Query format: "index,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw"
            # Example output: "0,45,8192,16384,62,150.0"
            cmd = [
                "nvidia-smi",
                f"--id={gpu_index}",
                "--query-gpu=index,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw",
                "--format=csv,noheader,nounits"
            ]
            
            result = subprocess.run(
                cmd,
                capture_output=True,
                timeout=5,
                text=True
            )
            
            if result.returncode != 0:
                logger.debug(f"nvidia-smi failed for GPU {gpu_index}: {result.stderr}")
                return None
            
            # Parse CSV output: "0,45,8192,16384,62,150.0"
            line = result.stdout.strip()
            if not line:
                return None
            
            parts = line.split(",")
            if len(parts) < 6:
                logger.debug(f"Unexpected nvidia-smi output: {line}")
                return None
            
            try:
                idx = int(parts[0].strip())
                util = int(parts[1].strip())
                mem_used = int(parts[2].strip())
                mem_total = int(parts[3].strip())
                temp = int(parts[4].strip())
                
                # Power draw may be "N/A"
                power_str = parts[5].strip()
                power = float(power_str) if power_str != "N/A" else None
                
                return GPUStats(
                    gpu_index=idx,
                    utilization=util,
                    memory_used_mb=mem_used,
                    memory_total_mb=mem_total,
                    temperature_c=temp,
                    power_draw_w=power,
                )
            
            except (ValueError, IndexError) as e:
                logger.debug(f"Failed to parse nvidia-smi output '{line}': {e}")
                return None
        
        except subprocess.TimeoutExpired:
            logger.warning(f"nvidia-smi timeout for GPU {gpu_index}")
            return None
        except Exception as e:
            logger.error(f"GPU telemetry poll error: {e}")
            return None
    
    def poll_all(self) -> list[Optional[GPUStats]]:
        """
        Poll all available GPUs.
        
        Returns:
            List of GPUStats (or None for failed queries).
        """
        if not self._available:
            return []
        
        try:
            result = subprocess.run(
                ["nvidia-smi", "--query-gpu=count"],
                capture_output=True,
                timeout=5,
                text=True
            )
            if result.returncode != 0:
                return []
            
            try:
                count = int(result.stdout.strip())
            except ValueError:
                return []
            
            return [self.poll(i) for i in range(count)]
        
        except Exception as e:
            logger.error(f"Failed to enumerate GPUs: {e}")
            return []


# Global telemetry instance
_telemetry_instance: Optional[GPUTelemetry] = None


def get_telemetry() -> GPUTelemetry:
    """Get or create global GPU telemetry instance."""
    global _telemetry_instance
    if _telemetry_instance is None:
        _telemetry_instance = GPUTelemetry()
    return _telemetry_instance
