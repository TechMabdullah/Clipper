#!/usr/bin/env python3
"""
🎬 Clipper Studio — Terminal User Interface (TUI) & Python CLI Control
A local-first terminal dashboard and controller for real-time live stream clipping,
chat explosion tracking, OpenCV facecam monitoring, Stripe SaaS billing, and VOD studio.
"""

import sys
import os
import re
import time
import json
import shutil
import argparse
import pathlib
import subprocess
import webbrowser
from datetime import datetime
from typing import Optional, Dict, Any, List, Tuple
from urllib.parse import quote

import requests
from rich.console import Console
from rich.layout import Layout
from rich.panel import Panel
from rich.table import Table
from rich.text import Text
from rich.align import Align
from rich.live import Live
from rich import box

# Windows non-blocking keyboard input
try:
    import msvcrt
    HAS_MSVCRT = True
except ImportError:
    HAS_MSVCRT = False

# POSIX non-blocking keyboard input
try:
    import select
    import termios
    import tty
    HAS_POSIX_TTY = True
except ImportError:
    HAS_POSIX_TTY = False

DEFAULT_API_URL = os.environ.get("CLIPPER_SERVICE_URL", "http://localhost:4001")


def resolve_media_clips_dir() -> str:
    """Intelligently resolves ClipperMedia/03_clips across Windows and POSIX systems."""
    candidate = os.environ.get("MEDIA_ROOT_DIR")
    if candidate:
        clips = os.path.abspath(os.path.join(candidate, "03_clips"))
        drive = os.path.splitdrive(clips)[0]
        drive_ok = True if sys.platform != "win32" else (not drive or os.path.exists(drive + os.sep))
        if drive_ok:
            try:
                os.makedirs(clips, exist_ok=True)
                return clips
            except Exception:
                pass

    drives: List[str] = []
    if sys.platform == "win32":
        for letter in "CDEFGHIJKLMNOPQRSTUVWXYZ":
            d_path = f"{letter}:\\"
            if os.path.exists(d_path):
                drives.append(d_path)
        current_drive = os.path.splitdrive(os.path.abspath(os.getcwd()))[0]
        current_root = (current_drive + os.sep) if current_drive else os.path.abspath(os.sep)
    else:
        drives = ["/"]
        current_root = "/"

    # If multiple Windows disks, check secondary disk first
    if len(drives) > 1:
        secondary = [d for d in drives if not d.upper().startswith("C:")]
        for sec in secondary:
            sec_clips = os.path.join(sec, "ClipperMedia", "03_clips")
            try:
                os.makedirs(sec_clips, exist_ok=True)
                return sec_clips
            except Exception:
                pass

    same_disk = os.path.join(current_root, "ClipperMedia", "03_clips")
    try:
        os.makedirs(same_disk, exist_ok=True)
        return same_disk
    except Exception:
        fallback = os.path.abspath(os.path.join(os.getcwd(), "ClipperMedia", "03_clips"))
        os.makedirs(fallback, exist_ok=True)
        return fallback


MEDIA_CLIPS_DIR = resolve_media_clips_dir()

LAYOUT_OPTIONS: List[Tuple[str, str]] = [
    ("split", "📱 Split: Facecam Top + Ambient 16:9 Game Bottom (9:16 Shorts)"),
    ("split-crop", "📱 Split: Facecam Top + Action Center Crop (9:16)"),
    ("portrait-4x5", "📲 4:5 Portrait (Instagram / Facebook Feed)"),
    ("square", "🟦 1:1 Square (X / LinkedIn / Feed)"),
    ("crop", "📱 9:16 Action Center Crop"),
    ("blur", "📱 9:16 Full Blurred Background"),
    ("landscape", "🖥️ 16:9 Landscape"),
]

FACECAM_OPTIONS: List[Tuple[str, str]] = [
    ("auto", "👤 Auto-Detect (OpenCV)"),
    ("top-left", "↖️ Top-Left"),
    ("top-right", "↗️ Top-Right"),
    ("bottom-left", "↙️ Bottom-Left"),
    ("bottom-right", "↘️ Bottom-Right"),
]

CAPTION_OPTIONS: List[Tuple[str, str]] = [
    ("none", "💬 Off (No Burned Captions)"),
    ("hormozi", "🔥 Hormozi Pop (Bold Yellow Kinetic — PRO)"),
    ("neon", "⚡ Cyber Neon (Cyan/Magenta Kinetic — PRO)"),
    ("minimal", "✨ Clean Minimal (White Subtitles — PRO)"),
]


def open_media_file(fpath: str) -> Tuple[bool, str]:
    """Opens a video file safely across Windows, macOS, and Linux."""
    abs_path = os.path.abspath(fpath)
    if not os.path.exists(abs_path):
        return False, f"File not found: {abs_path}"
    try:
        if sys.platform == "win32" and hasattr(os, "startfile"):
            os.startfile(abs_path)  # type: ignore[attr-defined]
            return True, f"Opened clip: {os.path.basename(abs_path)}"
        if sys.platform == "darwin":
            subprocess.Popen(["open", "--", abs_path], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return True, f"Opened clip: {os.path.basename(abs_path)}"
        xdg = shutil.which("xdg-open")
        if xdg:
            subprocess.Popen([xdg, abs_path], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return True, f"Opened clip: {os.path.basename(abs_path)}"
        return False, f"No desktop opener found (xdg-open). File at: {abs_path}"
    except Exception as exc:
        return False, f"Failed to open clip: {exc}"


def reveal_media_file(fpath: str) -> Tuple[bool, str]:
    """Reveals a rendered file in Windows Explorer, macOS Finder, or Linux file manager."""
    abs_path = os.path.abspath(fpath)
    if not os.path.exists(abs_path):
        return False, f"File not found: {abs_path}"
    try:
        if sys.platform == "win32":
            subprocess.run(["explorer", f"/select,{abs_path}"], check=False)
            return True, f"Revealed in Explorer: {os.path.basename(abs_path)}"
        if sys.platform == "darwin":
            subprocess.run(["open", "-R", abs_path], check=False)
            return True, f"Revealed in Finder: {os.path.basename(abs_path)}"
        xdg = shutil.which("xdg-open")
        if xdg:
            subprocess.Popen([xdg, os.path.dirname(abs_path)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return True, f"Opened folder: {os.path.dirname(abs_path)}"
        return False, f"File located at: {abs_path}"
    except Exception as exc:
        return False, f"Failed to reveal clip: {exc}"


class ClipperClient:
    """Client for Clipper Studio REST API with safe 402 & non-JSON 5xx handling."""

    def __init__(self, base_url: str = DEFAULT_API_URL):
        self.base_url = base_url.rstrip("/")

    @staticmethod
    def _csrf_headers() -> Dict[str, str]:
        return {"X-Clipper-CSRF": "1"}

    @staticmethod
    def _safe_json(res: requests.Response) -> Optional[Any]:
        try:
            return res.json()
        except (ValueError, json.JSONDecodeError):
            return None

    def _parse_response(self, res: requests.Response) -> Dict[str, Any]:
        """Normalizes API responses, returning structured 402 objects and raising cleanly on 5xx."""
        data = self._safe_json(res)
        dict_data = data if isinstance(data, dict) else {}

        if res.status_code == 402:
            err_msg = (
                dict_data.get("error")
                or dict_data.get("message")
                or res.text.strip()[:240]
                or "Plan upgrade required."
            )
            return {
                "ok": False,
                "error": str(err_msg),
                "code": dict_data.get("code", "PLAN_UPGRADE_REQUIRED"),
                "upgrade_required": True,
                "required_plan": str(dict_data.get("requiredPlan", "pro")),
                "current_plan": str(dict_data.get("currentPlan", "free")),
                "status_code": 402,
            }

        if res.status_code >= 500:
            err_msg = (
                dict_data.get("error")
                or dict_data.get("message")
                or res.text.strip()[:240]
                or f"Server error ({res.status_code} {res.reason})"
            )
            raise RuntimeError(f"HTTP {res.status_code}: {err_msg}")

        if not res.ok:
            err_msg = (
                dict_data.get("error")
                or dict_data.get("message")
                or res.text.strip()[:240]
                or f"HTTP {res.status_code} {res.reason}"
            )
            out = dict(dict_data)
            out["ok"] = False
            out["error"] = str(err_msg)
            out["status_code"] = res.status_code
            return out

        if isinstance(data, dict):
            result = dict(data)
            result.setdefault("ok", True)
            return result
        return {"ok": True, "data": data}

    def get_status(self) -> Dict[str, Any]:
        try:
            res = requests.get(f"{self.base_url}/api/live/status", timeout=2.0)
            if res.status_code == 200:
                data = self._safe_json(res)
                if isinstance(data, dict):
                    data.setdefault("connected", True)
                    return data
        except Exception:
            pass
        return {"active": False, "connected": False}

    def get_billing_status(self, raise_on_error: bool = False) -> Dict[str, Any]:
        try:
            res = requests.get(f"{self.base_url}/api/billing/status", timeout=2.5)
            return self._parse_response(res)
        except Exception:
            if raise_on_error:
                raise
            return {}

    def activate_license(self, license_key: str) -> Dict[str, Any]:
        res = requests.post(
            f"{self.base_url}/api/billing/activate",
            json={"licenseKey": license_key.strip()},
            headers=self._csrf_headers(),
            timeout=15.0,
        )
        return self._parse_response(res)

    def deactivate_license(self) -> Dict[str, Any]:
        res = requests.post(
            f"{self.base_url}/api/billing/deactivate",
            headers=self._csrf_headers(),
            timeout=10.0,
        )
        return self._parse_response(res)

    def create_checkout(self, plan_id: str, email: str = "") -> Dict[str, Any]:
        payload: Dict[str, Any] = {"planId": plan_id}
        if email.strip():
            payload["email"] = email.strip()
        res = requests.post(
            f"{self.base_url}/api/billing/checkout",
            json=payload,
            headers=self._csrf_headers(),
            timeout=15.0,
        )
        return self._parse_response(res)

    def get_facecam(self) -> Optional[Dict[str, Any]]:
        try:
            res = requests.get(f"{self.base_url}/api/live/preview-facecam", timeout=2.0)
            if res.status_code == 200:
                data = self._safe_json(res)
                if isinstance(data, dict):
                    return data.get("facecam")
        except Exception:
            pass
        return None

    def start_session(
        self,
        platform: str,
        channel: str,
        layout: str = "split",
        facecam: str = "auto",
        caption_style: str = "none",
        watermark_text: str = "",
        hook_title: str = "",
        audio_normalize: bool = False,
        trigger_keywords: Optional[List[str]] = None,
        spike_multiplier: float = 2.5,
        min_spike: float = 4.0,
        save_recording: bool = False,
    ) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            "platform": platform,
            "channelOrUrl": channel,
            "vertical": layout != "landscape",
            "layout": layout,
            "facecamPosition": facecam,
            "captionStyle": caption_style,
            "audioNormalize": audio_normalize,
            "spikeMultiplier": spike_multiplier,
            "minSpikeThreshold": min_spike,
            "saveRecording": save_recording,
        }
        if watermark_text.strip():
            payload["watermarkText"] = watermark_text.strip()
        if hook_title.strip():
            payload["hookTitleText"] = hook_title.strip()
        if trigger_keywords:
            payload["triggerKeywords"] = trigger_keywords

        res = requests.post(
            f"{self.base_url}/api/live/start",
            json=payload,
            headers=self._csrf_headers(),
            timeout=10.0,
        )
        return self._parse_response(res)

    def stop_session(self) -> Dict[str, Any]:
        res = requests.post(
            f"{self.base_url}/api/live/stop",
            headers=self._csrf_headers(),
            timeout=20.0,
        )
        return self._parse_response(res)

    def clip_now(self, duration_sec: int = 20) -> Dict[str, Any]:
        res = requests.post(
            f"{self.base_url}/api/live/clip-now",
            json={"durationSec": duration_sec},
            headers=self._csrf_headers(),
            timeout=90.0,
        )
        return self._parse_response(res)

    def get_clips(self, raise_on_error: bool = False) -> List[Dict[str, Any]]:
        try:
            res = requests.get(f"{self.base_url}/api/clipper/clips", timeout=4.0)
            if res.status_code == 200:
                data = self._safe_json(res)
                if isinstance(data, list):
                    return data
                if isinstance(data, dict) and isinstance(data.get("clips"), list):
                    return data["clips"]
            if raise_on_error:
                parsed = self._parse_response(res)
                raise RuntimeError(parsed.get("error", f"HTTP {res.status_code}"))
        except Exception:
            if raise_on_error:
                raise
        return []

    def generate_clip_metadata(self, clip_id: str) -> Dict[str, Any]:
        res = requests.post(
            f"{self.base_url}/api/clipper/clips/{clip_id}/metadata",
            headers=self._csrf_headers(),
            timeout=25.0,
        )
        return self._parse_response(res)

    def toggle_favourite(self, clip_id: str) -> Dict[str, Any]:
        res = requests.post(
            f"{self.base_url}/api/clipper/clips/{clip_id}/favourite",
            headers=self._csrf_headers(),
            timeout=10.0,
        )
        return self._parse_response(res)

    def update_tags(self, clip_id: str, tags: List[str]) -> Dict[str, Any]:
        res = requests.post(
            f"{self.base_url}/api/clipper/clips/{clip_id}/tags",
            json={"tags": tags},
            headers=self._csrf_headers(),
            timeout=10.0,
        )
        return self._parse_response(res)

    def update_notes(self, clip_id: str, notes: str) -> Dict[str, Any]:
        res = requests.patch(
            f"{self.base_url}/api/clipper/clips/{clip_id}/notes",
            json={"notes": notes},
            headers=self._csrf_headers(),
            timeout=10.0,
        )
        return self._parse_response(res)

    def get_analytics(self) -> Dict[str, Any]:
        res = requests.get(f"{self.base_url}/api/analytics/summary", timeout=10.0)
        return self._parse_response(res)

    def check_system_version(self, check_remote: bool = False) -> Dict[str, Any]:
        params = {"checkRemote": "1"} if check_remote else {}
        res = requests.get(
            f"{self.base_url}/api/system/version",
            params=params,
            timeout=15.0 if check_remote else 5.0,
        )
        return self._parse_response(res)

    def get_upgrade_link(self, plan_id: str) -> Dict[str, Any]:
        """Get the Stripe Checkout/upgrade link for the given plan."""
        try:
            res = requests.get(
                f"{self.base_url}/api/licensing/upgrade-link",
                params={"plan": plan_id},
                timeout=5.0,
            )
            return self._parse_response(res)
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    def get_local_videos(self) -> List[Dict[str, Any]]:
        try:
            res = requests.get(f"{self.base_url}/api/studio/local-videos", timeout=3.0)
            if res.status_code == 200:
                data = self._safe_json(res)
                if isinstance(data, dict):
                    return data.get("videos", [])
        except Exception:
            pass
        return []

    def get_music_tracks(self) -> List[Dict[str, Any]]:
        try:
            res = requests.get(f"{self.base_url}/api/studio/music", timeout=3.0)
            if res.status_code == 200:
                data = self._safe_json(res)
                if isinstance(data, dict):
                    return data.get("tracks", [])
        except Exception:
            pass
        return []

    def get_past_streams(self, platform: str, channel: str) -> List[Dict[str, Any]]:
        res = requests.get(
            f"{self.base_url}/api/studio/past-streams",
            params={"platform": platform, "channel": channel},
            timeout=25.0,
        )
        parsed = self._parse_response(res)
        if not parsed.get("ok"):
            raise RuntimeError(parsed.get("error", "Failed to load past streams"))
        return parsed.get("streams", [])

    def scan_audio_peaks(
        self,
        source: str,
        stream_url: str = "",
        clip_duration_sec: int = 25,
    ) -> Dict[str, Any]:
        res = requests.post(
            f"{self.base_url}/api/studio/audio-peaks",
            json={
                "source": source,
                "streamUrl": stream_url,
                "clipDurationSec": clip_duration_sec,
            },
            headers=self._csrf_headers(),
            timeout=150.0,
        )
        return self._parse_response(res)

    def auto_clip_batch(
        self,
        source: str,
        top_n: int = 3,
        layout: str = "split",
        facecam: str = "auto",
        caption_style: str = "none",
        watermark_text: str = "",
        hook_title: str = "",
        audio_normalize: bool = False,
        trim_silence: bool = False,
        music_path: str = "",
        music_volume: float = 0.18,
        stream_url: str = "",
    ) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            "source": source,
            "maxClips": top_n,
            "layout": layout,
            "facecamPosition": facecam,
            "captionStyle": caption_style,
            "audioNormalize": audio_normalize,
            "silenceCut": trim_silence,
            "streamUrl": stream_url,
        }
        if watermark_text.strip():
            payload["watermarkText"] = watermark_text.strip()
        if hook_title.strip():
            payload["hookTitleText"] = hook_title.strip()
        if music_path.strip():
            payload["musicTrack"] = music_path.strip()
            payload["musicVolume"] = music_volume

        res = requests.post(
            f"{self.base_url}/api/studio/auto-clip-batch",
            json=payload,
            headers=self._csrf_headers(),
            timeout=300.0,
        )
        return self._parse_response(res)

    def compile_montage(
        self,
        clip_ids: List[str],
        title: str = "montage_reel",
        music_path: str = "",
        music_volume: float = 0.18,
        audio_normalize: bool = False,
    ) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            "clipIds": clip_ids,
            "title": title,
            "audioNormalize": audio_normalize,
        }
        if music_path.strip():
            payload["musicTrack"] = music_path.strip()
            payload["musicVolume"] = music_volume

        res = requests.post(
            f"{self.base_url}/api/studio/compile-montage",
            json=payload,
            headers=self._csrf_headers(),
            timeout=300.0,
        )
        return self._parse_response(res)

    def cut_manual_clip(
        self,
        source: str,
        start_sec: float,
        end_sec: float,
        layout: str = "split",
        facecam: str = "auto",
        title: str = "",
        stream_url: str = "",
        caption_style: str = "none",
        watermark_text: str = "",
        hook_title: str = "",
        audio_normalize: bool = False,
        trim_silence: bool = False,
        music_path: str = "",
        music_volume: float = 0.18,
        audio_delta_db: float = 0.0,
    ) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            "source": source,
            "startSec": start_sec,
            "endSec": end_sec,
            "layout": layout,
            "facecamPosition": facecam,
            "title": title,
            "streamUrl": stream_url,
            "captionStyle": caption_style,
            "audioNormalize": audio_normalize,
            "silenceCut": trim_silence,
        }
        if watermark_text.strip():
            payload["watermarkText"] = watermark_text.strip()
        if hook_title.strip():
            payload["hookTitleText"] = hook_title.strip()
        if music_path.strip():
            payload["musicTrack"] = music_path.strip()
            payload["musicVolume"] = music_volume
        if audio_delta_db > 0:
            payload["audioDeltaDb"] = audio_delta_db

        res = requests.post(
            f"{self.base_url}/api/studio/clip",
            json=payload,
            headers=self._csrf_headers(),
            timeout=240.0,
        )
        return self._parse_response(res)

    def list_presets(self, raise_on_error: bool = False) -> List[Dict[str, Any]]:
        """Lists built-in and custom export presets from /api/presets."""
        try:
            res = requests.get(f"{self.base_url}/api/presets", timeout=5.0)
            parsed = self._parse_response(res)
            if parsed.get("ok") and isinstance(parsed.get("presets"), list):
                return parsed["presets"]
            if raise_on_error:
                raise RuntimeError(parsed.get("error", "Failed to fetch presets"))
        except Exception:
            if raise_on_error:
                raise
        return []

    def create_preset(
        self,
        name: str,
        description: str = "",
        layout: str = "split",
        facecam_position: str = "auto",
        caption_style: str = "none",
        silence_cut: bool = False,
        audio_normalize: bool = True,
        music_track: str = "",
        music_volume: float = 0.15,
        hook_title: str = "",
        watermark_text: str = "",
    ) -> Dict[str, Any]:
        """Creates a custom export preset via POST /api/presets."""
        payload: Dict[str, Any] = {
            "name": name.strip(),
            "layout": layout,
            "facecamPosition": facecam_position,
            "captionStyle": caption_style,
            "silenceCut": silence_cut,
            "audioNormalize": audio_normalize,
            "musicTrack": music_track.strip(),
            "musicVolume": music_volume,
            "hookTitle": hook_title.strip(),
            "watermarkText": watermark_text.strip(),
        }
        if description.strip():
            payload["description"] = description.strip()
        res = requests.post(
            f"{self.base_url}/api/presets",
            json=payload,
            headers=self._csrf_headers(),
            timeout=10.0,
        )
        return self._parse_response(res)

    def reexport_clip(self, clip_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        """Trims or re-exports an existing clip via POST /api/clipper/clips/:id/re-export."""
        res = requests.post(
            f"{self.base_url}/api/clipper/clips/{quote(clip_id, safe='')}/re-export",
            json=payload,
            headers=self._csrf_headers(),
            timeout=300.0,
        )
        return self._parse_response(res)

    def batch_metadata(self, clip_ids: List[str]) -> Dict[str, Any]:
        """Generates AI social metadata for up to 20 clips via POST /api/clipper/clips/batch-metadata."""
        res = requests.post(
            f"{self.base_url}/api/clipper/clips/batch-metadata",
            json={"clipIds": clip_ids},
            headers=self._csrf_headers(),
            timeout=120.0,
        )
        return self._parse_response(res)

    def export_clips_csv(self, params: Optional[Dict[str, Any]] = None) -> str:
        """Downloads CSV export of clips library from GET /api/clipper/clips/export.csv."""
        res = requests.get(
            f"{self.base_url}/api/clipper/clips/export.csv",
            params=params or {},
            timeout=20.0,
        )
        if not res.ok:
            parsed = self._parse_response(res)
            raise RuntimeError(parsed.get("error", f"HTTP {res.status_code}"))
        return res.text

    def get_clip_kit(self, clip_id: str) -> Dict[str, Any]:
        """Fetches the Creator Kit JSON bundle from GET /api/clipper/clips/:id/kit."""
        res = requests.get(
            f"{self.base_url}/api/clipper/clips/{quote(clip_id, safe='')}/kit",
            timeout=15.0,
        )
        return self._parse_response(res)

    def get_diagnostics(self) -> Dict[str, Any]:
        """Fetches system dependencies, storage, counts, and security posture from /api/system/diagnostics."""
        res = requests.get(f"{self.base_url}/api/system/diagnostics", timeout=10.0)
        return self._parse_response(res)

    def delete_preset(self, preset_id: str) -> Dict[str, Any]:
        """Deletes a custom export preset via DELETE /api/presets/:id."""
        res = requests.delete(
            f"{self.base_url}/api/presets/{quote(preset_id, safe='')}",
            headers=self._csrf_headers(),
            timeout=10.0,
        )
        return self._parse_response(res)

    def list_collections(self, raise_on_error: bool = False) -> List[Dict[str, Any]]:
        """Lists all clip collections from GET /api/clipper/collections."""
        try:
            res = requests.get(f"{self.base_url}/api/clipper/collections", timeout=10.0)
            parsed = self._parse_response(res)
            if parsed.get("ok") and isinstance(parsed.get("collections"), list):
                return parsed["collections"]
            if raise_on_error:
                raise RuntimeError(parsed.get("error", "Failed to fetch collections"))
        except Exception:
            if raise_on_error:
                raise
        return []

    def create_collection(self, name: str, description: str = "", color: str = "#6366f1") -> Dict[str, Any]:
        """Creates a new clip collection via POST /api/clipper/collections."""
        payload: Dict[str, Any] = {
            "name": name.strip(),
            "description": description.strip(),
            "color": color.strip() or "#6366f1",
        }
        res = requests.post(
            f"{self.base_url}/api/clipper/collections",
            json=payload,
            headers=self._csrf_headers(),
            timeout=10.0,
        )
        return self._parse_response(res)

    def add_clip_to_collection(self, collection_id: str, clip_id: str) -> Dict[str, Any]:
        """Adds a clip to a collection via POST /api/clipper/collections/:id/clips."""
        res = requests.post(
            f"{self.base_url}/api/clipper/collections/{quote(collection_id, safe='')}/clips",
            json={"clipId": clip_id.strip()},
            headers=self._csrf_headers(),
            timeout=10.0,
        )
        return self._parse_response(res)

    def rate_clip(self, clip_id: str, rating: int) -> Dict[str, Any]:
        """Rates a clip (1-5 stars) via POST /api/clipper/clips/:id/rate."""
        res = requests.post(
            f"{self.base_url}/api/clipper/clips/{quote(clip_id, safe='')}/rate",
            json={"rating": int(rating)},
            headers=self._csrf_headers(),
            timeout=10.0,
        )
        return self._parse_response(res)

    def get_top_rated_clips(self, limit: int = 10, raise_on_error: bool = False) -> List[Dict[str, Any]]:
        """Fetches top-rated clips from GET /api/clipper/clips/top-rated."""
        try:
            res = requests.get(
                f"{self.base_url}/api/clipper/clips/top-rated",
                params={"limit": int(limit)},
                timeout=10.0,
            )
            parsed = self._parse_response(res)
            if parsed.get("ok") and isinstance(parsed.get("clips"), list):
                return parsed["clips"]
            if raise_on_error:
                raise RuntimeError(parsed.get("error", "Failed to fetch top-rated clips"))
        except Exception:
            if raise_on_error:
                raise
        return []

    def list_comments(self, clip_id: str, raise_on_error: bool = False) -> List[Dict[str, Any]]:
        """Lists review comments for a clip via GET /api/clipper/clips/:id/comments."""
        try:
            res = requests.get(
                f"{self.base_url}/api/clipper/clips/{quote(clip_id, safe='')}/comments",
                timeout=10.0,
            )
            parsed = self._parse_response(res)
            if parsed.get("ok") and isinstance(parsed.get("comments"), list):
                return parsed["comments"]
            if raise_on_error:
                raise RuntimeError(parsed.get("error", "Failed to fetch comments"))
        except Exception:
            if raise_on_error:
                raise
        return []

    def add_comment(
        self,
        clip_id: str,
        body: str,
        author: str = "cli",
        timestamp_sec: Optional[float] = None,
    ) -> Dict[str, Any]:
        """Adds a timestamped review comment to a clip via POST /api/clipper/clips/:id/comments."""
        payload: Dict[str, Any] = {
            "body": body.strip(),
            "author": author.strip() or "cli",
        }
        if timestamp_sec is not None:
            payload["timestampSec"] = float(timestamp_sec)
        res = requests.post(
            f"{self.base_url}/api/clipper/clips/{quote(clip_id, safe='')}/comments",
            json=payload,
            headers=self._csrf_headers(),
            timeout=10.0,
        )
        return self._parse_response(res)

    def create_share_link(
        self,
        clip_id: str,
        expires_in_hours: Optional[float] = None,
        max_views: Optional[int] = None,
        password: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Creates a shareable clip link via POST /api/clipper/clips/:id/shares."""
        payload: Dict[str, Any] = {}
        if expires_in_hours is not None:
            payload["expiresInHours"] = float(expires_in_hours)
        if max_views is not None:
            payload["maxViews"] = int(max_views)
        if password is not None and password != "":
            payload["password"] = password
        res = requests.post(
            f"{self.base_url}/api/clipper/clips/{quote(clip_id, safe='')}/shares",
            json=payload,
            headers=self._csrf_headers(),
            timeout=10.0,
        )
        return self._parse_response(res)

    def list_upload_queue(self) -> Dict[str, Any]:
        """Fetches Social Upload Queue items and platform stats from GET /api/studio/upload-queue."""
        res = requests.get(f"{self.base_url}/api/studio/upload-queue", timeout=10.0)
        return self._parse_response(res)

    def add_to_upload_queue(
        self,
        clip_id: str,
        platform: str,
        title: str,
        description: str = "",
        tags: str = "",
    ) -> Dict[str, Any]:
        """Queues a clip for social upload via POST /api/studio/upload-queue."""
        payload: Dict[str, Any] = {
            "clipId": clip_id.strip(),
            "platform": platform.strip().lower(),
            "title": title.strip(),
            "description": description.strip(),
            "tags": tags.strip(),
        }
        res = requests.post(
            f"{self.base_url}/api/studio/upload-queue",
            json=payload,
            headers=self._csrf_headers(),
            timeout=10.0,
        )
        return self._parse_response(res)


def _save_and_render_creator_kit(console: Console, clip_id: str, res: Dict[str, Any]) -> str:
    """Writes creator_kit_<id8>.json and renders a Rich summary panel."""
    kit_path = f"creator_kit_{clip_id[:8]}.json"
    pathlib.Path(kit_path).write_text(json.dumps(res, indent=2, ensure_ascii=False), encoding="utf-8")

    clip_meta = res.get("clip") or {}
    social_title = str(res.get("socialTitle") or clip_meta.get("social_title") or clip_meta.get("title") or "")
    social_desc = str(res.get("socialDescription") or clip_meta.get("description") or "")
    hashtags = res.get("hashtags") or []
    tag_line = " ".join(str(h) for h in hashtags) if isinstance(hashtags, list) else str(hashtags)
    platforms = res.get("platforms") or res.get("platformCopy") or {}
    srt_text = str(res.get("srt") or "")
    srt_info = f"{len(srt_text.splitlines())} lines" if srt_text.strip() else "None"

    lines: List[Tuple[str, str]] = [
        ("File:      ", "bold cyan"), (f"{kit_path}\n", "bold green"),
        ("Title:     ", "bold cyan"), (f"{social_title}\n", "bold white"),
    ]
    if social_desc:
        lines.extend([("Desc:      ", "bold cyan"), (f"{social_desc[:140]}\n", "white")])
    if tag_line:
        lines.extend([("Hashtags:  ", "bold cyan"), (f"{tag_line}\n", "green")])
    for plat, copy in platforms.items():
        if isinstance(copy, dict):
            preview = str(copy.get("title") or copy.get("caption") or "").replace("\n", " ")[:90]
            lines.extend([(f"[{plat}]: ", "bold magenta"), (f"{preview}\n", "dim")])
    lines.extend([("SRT:       ", "bold cyan"), (srt_info, "yellow")])

    console.print(Panel(Text.assemble(*lines), title="📦 Creator Kit", box=box.ROUNDED, style="cyan"))
    return kit_path


def _render_presets_table(console: Console, presets: List[Dict[str, Any]], numbered: bool = False) -> None:
    """Renders saved editing presets in a Rich table."""
    table = Table(title="⚡ Saved Editing Presets", box=box.ROUNDED, expand=True)
    if numbered:
        table.add_column("#", justify="right", style="cyan", width=3, no_wrap=True)
    else:
        table.add_column("ID", style="dim", width=10, no_wrap=True)
    table.add_column("Name", style="bold white", min_width=14, ratio=2)
    table.add_column("Type", width=8, no_wrap=True)
    table.add_column("Layout", style="cyan", min_width=8)
    table.add_column("Facecam", style="green", min_width=8)
    table.add_column("Captions", style="magenta", min_width=7)
    table.add_column("Audio", min_width=8, ratio=1)
    table.add_column("Description", style="dim", min_width=12, ratio=2)

    for idx, pr in enumerate(presets, 1):
        is_builtin = pr.get("is_builtin") in (1, True)
        kind = Text("Built-in", style="dim") if is_builtin else Text("★ Custom", style="bold yellow")
        flags: List[str] = []
        if pr.get("audio_normalize") or pr.get("audioNormalize"):
            flags.append("-14LUFS")
        if pr.get("silence_cut") or pr.get("silenceCut"):
            flags.append("SilCut")
        if pr.get("music_track") or pr.get("musicTrack"):
            flags.append("Music")
        first_col = str(idx) if numbered else str(pr.get("id", ""))[:10]
        table.add_row(
            first_col,
            str(pr.get("name", "")),
            kind,
            str(pr.get("layout", "split")),
            str(pr.get("facecam_position") or pr.get("facecamPosition") or "auto"),
            str(pr.get("caption_style") or pr.get("captionStyle") or "none"),
            ", ".join(flags) or "Default",
            str(pr.get("description") or "")[:45],
        )
    console.print(table)


def _render_diagnostics(console: Console, diag: Dict[str, Any]) -> None:
    """Renders /api/system/diagnostics binary checks, storage, counts, and security in Rich tables."""
    binaries = diag.get("binaries") or {}
    bin_table = Table(title="🩺 System Dependencies & Binaries", box=box.ROUNDED)
    bin_table.add_column("Dependency", style="bold cyan", width=16)
    bin_table.add_column("Status", width=14)
    bin_table.add_column("Version / Path", style="dim")

    ytdlp_info = binaries.get("ytDlp")
    if ytdlp_info is None:
        ytdlp_info = binaries.get("ytdlp") if binaries.get("ytdlp") is not None else binaries.get("yt-dlp")

    checks = [
        ("ffmpeg", binaries.get("ffmpeg")),
        ("ffprobe", binaries.get("ffprobe")),
        ("yt-dlp", ytdlp_info),
        ("streamlink", binaries.get("streamlink")),
        ("python", binaries.get("python")),
        ("opencv", binaries.get("opencv")),
    ]
    for label, info in checks:
        if isinstance(info, bool):
            available = info
            detail = "Detected" if available else "Not found in PATH"
        elif isinstance(info, dict):
            available = bool(
                info.get("available")
                or info.get("ok")
                or info.get("installed")
                or info.get("found")
            )
            detail = str(info.get("version") or info.get("path") or info.get("error") or ("Detected" if available else "Missing"))
        else:
            available = bool(info)
            detail = str(info) if info else "Missing"
        status_txt = Text("✅ Available", style="bold green") if available else Text("❌ Missing", style="bold red")
        bin_table.add_row(label, status_txt, detail[:90])
    console.print(bin_table)

    storage = diag.get("storage") or {}
    counts = diag.get("counts") or {}
    security = diag.get("security") or {}

    meta_table = Table(title="Storage, Database Counts & Security Posture", box=box.ROUNDED)
    meta_table.add_column("Category", style="bold magenta", width=16)
    meta_table.add_column("Summary", style="white")

    storage_parts: List[str] = []
    if storage.get("mediaRoot"):
        mode = "Single-Disk" if storage.get("isSingleDisk") else "Multi-Disk"
        storage_parts.append(f"Root: {storage['mediaRoot']} ({mode})")
    if isinstance(storage.get("freeBytes"), (int, float)):
        storage_parts.append(f"Free: {float(storage['freeBytes']) / 1e9:.2f} GB")
    meta_table.add_row("Storage", " | ".join(storage_parts) or "—")

    counts_parts = [
        f"clips={counts.get('clips', 0)}",
        f"clip_presets={counts.get('clip_presets', counts.get('presets', 0))}",
        f"scheduled_jobs={counts.get('scheduled_jobs', counts.get('scheduledJobs', 0))}",
        f"outbound_webhooks={counts.get('outbound_webhooks', counts.get('outboundWebhooks', 0))}",
    ]
    meta_table.add_row("DB Counts", " • ".join(counts_parts))

    sec_parts = [f"{k}={v}" for k, v in security.items()] if isinstance(security, dict) else []
    meta_table.add_row("Security", " • ".join(sec_parts) or "CSP + CSRF + Admin Auth Active")
    console.print(meta_table)


class ClipperTUI:
    """Rich-powered Terminal User Interface for Clipper Studio."""

    def __init__(self, client: ClipperClient):
        self.client = client
        self.console = Console()
        self.running = True
        self.last_facecam: Optional[Dict[str, Any]] = None
        self.billing_cache: Dict[str, Any] = {}
        self.poll_tick = 0
        self.status_message = "Ready. Press [S] to start monitoring, [K] for Plans/License, or [Q] to quit."
        self.status_color = "cyan"
        self.layout_idx = 0
        self.facecam_idx = 0
        self.caption_idx = 0

    def _format_api_error(self, res: Dict[str, Any], prefix: str = "Error") -> str:
        msg = res.get("error", "Unknown error")
        if res.get("upgrade_required"):
            formatted = f"[🔒 LOCKED] {msg} — Press [K] to activate Stripe ID/Key or upgrade!"
            self.status_message = formatted
            self.status_color = "bold yellow"
            return formatted
        formatted = f"❌ {prefix}: {msg}"
        self.status_message = formatted
        self.status_color = "bold red"
        return formatted

    def _refresh_billing_cache(self, force: bool = False) -> None:
        if force or self.poll_tick % 12 == 0 or not self.billing_cache:
            info = self.client.get_billing_status(raise_on_error=False)
            if info.get("ok"):
                self.billing_cache = info

    def make_header(self, status: Dict[str, Any]) -> Panel:
        connected = status.get("connected", True)
        if not connected:
            conn_text = Text("● API OFFLINE (Check Clipper Service on :4001)", style="bold red")
        else:
            conn_text = Text(f"● API Connected ({self.client.base_url})", style="bold green")

        plan_badge = Text("Plan: —", style="dim")
        ent = self.billing_cache.get("entitlement")
        if isinstance(ent, dict):
            plan = ent.get("plan", {})
            usage = ent.get("usage", {})
            plan_id = str(plan.get("id", "free")).upper()
            max_res = plan.get("max_resolution", 720)
            used_today = usage.get("usedToday", 0)
            daily_limit = usage.get("dailyLimit", 3)
            unlimited = bool(usage.get("unlimited", False)) or daily_limit < 0
            if unlimited:
                quota_str = f"Unlimited • {max_res}p"
            else:
                quota_str = f"{used_today}/{daily_limit} today • {max_res}p"

            if plan_id == "ULTRA":
                badge_style = "bold cyan"
                icon = "🚀"
            elif plan_id == "PRO":
                badge_style = "bold magenta"
                icon = "💎"
            else:
                badge_style = "bold yellow" if (not unlimited and used_today >= daily_limit) else "bold white"
                icon = "🆓"
            plan_badge = Text(f"{icon} {plan_id} ({quota_str})", style=badge_style)
            # Upgrade hint for non-Ultra users
            if plan_id not in ("ULTRA",):
                target = "Ultra" if plan_id == "PRO" else "Pro"
                plan_badge.append(f"  💎 Press [U] to upgrade to {target}", style="bold cyan dim")

        title = Text("🎬 CLIPPER STUDIO", style="bold magenta")
        subtitle = Text(" — Live & VOD Clipper", style="dim")
        header_text = Text.assemble(title, subtitle, " | ", plan_badge, " | ", conn_text)
        return Panel(header_text, style="blue", box=box.ROUNDED)

    def make_live_monitor_panel(self, status: Dict[str, Any]) -> Panel:
        is_active = status.get("active", False)
        table = Table.grid(expand=True, padding=(0, 2))
        table.add_column(ratio=6)
        table.add_column(ratio=4)

        if not is_active:
            left = Text.assemble(
                ("LIVE STATUS: ", "bold"),
                ("● IDLE / STANDBY\n", "bold dim yellow"),
                ("No active live stream being monitored.\n\n", "dim"),
                ("Selected Layout:   ", "bold"),
                (f"{LAYOUT_OPTIONS[self.layout_idx][1]}\n", "cyan"),
                ("Selected Facecam:  ", "bold"),
                (f"{FACECAM_OPTIONS[self.facecam_idx][1]}\n", "green"),
                ("Selected Captions: ", "bold"),
                (f"{CAPTION_OPTIONS[self.caption_idx][1]}\n\n", "magenta"),
                ("Press ", "dim"),
                ("[S]", "bold yellow"),
                (" to start monitoring Twitch, Kick, or YouTube.\n", "dim"),
                ("Press ", "dim"),
                ("[L]", "bold cyan"),
                (" layout | ", "dim"),
                ("[F]", "bold green"),
                (" facecam | ", "dim"),
                ("[K]", "bold magenta"),
                (" Stripe Plans/Key.", "dim"),
            )
            right = Panel(
                Align.center(
                    Text("\n\nWaiting for stream to monitor...\n", style="italic dim"),
                    vertical="middle",
                ),
                title="Hype Velocity",
                box=box.ROUNDED,
                style="dim",
            )
        else:
            platform = str(status.get("platform") or "").upper()
            target = status.get("channelOrUrl", "")
            layout_name = status.get("layout", "split")
            facecam_pos = status.get("facecamPosition", "auto")
            caption_style = status.get("captionStyle", "none")
            hook_title = status.get("hookTitleText", "")
            triggers = status.get("triggerKeywords") or []

            face_desc = facecam_pos
            if self.last_facecam and self.last_facecam.get("found"):
                fc = self.last_facecam
                face_desc = f"{fc.get('corner')} (x={fc.get('crop_x')}, y={fc.get('crop_y')}, w={fc.get('crop_w')}, h={fc.get('crop_h')})"

            extras = []
            if caption_style and caption_style != "none":
                extras.append(f"Captions={caption_style}")
            if status.get("audioNormalize"):
                extras.append("-14 LUFS")
            if hook_title:
                extras.append(f"Hook='{hook_title[:24]}'")
            if triggers:
                extras.append(f"Triggers={','.join(triggers[:3])}")
            extras_line = " • ".join(extras) if extras else "Starts -10s before spike | 20s min to 40s max"

            left = Text.assemble(
                ("LIVE STATUS: ", "bold"),
                ("🔴 MONITORING\n", "bold red"),
                ("Platform: ", "bold"),
                (f"{platform}\n", "magenta"),
                ("Streamer: ", "bold"),
                (f"{target}\n", "bold white"),
                ("Layout: ", "bold"),
                (f"{layout_name}\n", "cyan"),
                ("Webcam Tracker: ", "bold"),
                (f"{face_desc}\n", "green"),
                ("Options: ", "bold"),
                (f"{extras_line}\n", "dim"),
            )

            current_vel = float(status.get("currentVelocity", 0.0))
            baseline_vel = float(status.get("baselineVelocity", 0.0))
            multiplier = (current_vel / baseline_vel) if baseline_vel > 0 else 1.0

            bar_len = 20
            fill_len = min(bar_len, int((current_vel / 25.0) * bar_len))
            bar_chars = "█" * fill_len + "░" * (bar_len - fill_len)

            is_spike = current_vel >= (baseline_vel * 2.5) and current_vel >= 4.0
            spike_tag = Text("🔥 CHAT EXPLODING!", style="bold red blink") if is_spike else Text("Normal Velocity", style="dim green")

            gauge_content = Text.assemble(
                ("Current Velocity:  ", "bold"),
                (f"{current_vel:.1f} msg/s\n", "bold yellow" if current_vel > 4 else "white"),
                ("Rolling Baseline:  ", "bold"),
                (f"{baseline_vel:.1f} msg/s (60s)\n", "dim"),
                ("Spike Multiplier:  ", "bold"),
                (f"{multiplier:.2f}x\n\n", "bold red" if multiplier >= 2.5 else "cyan"),
                (f"[{bar_chars}] {current_vel:.1f}/25\n\n", "red" if is_spike else "cyan"),
                ("Status: ", "bold"),
                spike_tag,
            )
            right = Panel(gauge_content, title="Real-Time Chat Hype", box=box.ROUNDED, style="yellow" if is_spike else "blue")

        table.add_row(left, right)
        return Panel(table, title="Stream Monitor & Velocity", box=box.ROUNDED, style="cyan")

    def make_clips_panel(self, status: Dict[str, Any]) -> Panel:
        recent = status.get("recentClips", [])
        table = Table(box=box.SIMPLE_HEAD, expand=True)
        table.add_column("Time", style="dim", width=10)
        table.add_column("File / Clip Title", style="cyan", ratio=5)
        table.add_column("🔥", justify="right", style="green", width=7)
        table.add_column("Location", style="dim", ratio=4)

        if not recent:
            db_clips = self.client.get_clips()[:3]
            if db_clips:
                for c in db_clips:
                    ts = c.get("created_at", "")[:19].replace("T", " ")
                    title = c.get("title", "clip")
                    score = float(c.get("virality_score") or 0)
                    score_str = f"{int(round(score))}" if score > 0 else "—"
                    fpath = c.get("file_path", "")
                    table.add_row(ts[11:19] if len(ts) >= 19 else ts, title, score_str, fpath)
            else:
                table.add_row("—", "No clips generated yet. Waiting for chat explosion or manual clip.", "—", "—")
        else:
            for item in recent[-5:]:
                ts = item.get("timestamp", "")
                fpath = item.get("filePath", "")
                name = os.path.basename(fpath)
                table.add_row(ts[11:19] if len(ts) >= 19 else ts, name, "LIVE", fpath)

        storage_meta = status.get("storage", {})
        active_media = storage_meta.get("clipsDir") or storage_meta.get("mediaRoot") or MEDIA_CLIPS_DIR
        mode_str = "Single-Disk" if storage_meta.get("isSingleDisk", False) else "Dual-Disk"
        panel_title = f"Recently Caught Clips ({active_media} • {mode_str})"
        return Panel(table, title=panel_title, box=box.ROUNDED, style="magenta")

    def make_live_chat_panel(self, status: Dict[str, Any]) -> Panel:
        is_active = status.get("active", False)
        recent_chat = status.get("recentChat", [])
        if not is_active:
            content = Align.center(
                Text("\nStart monitoring a live stream [S] to see real-time chat preview.\n", style="dim italic"),
                vertical="middle",
            )
            return Panel(content, title="💬 Live Chat Preview", box=box.ROUNDED, style="dim")

        if not recent_chat:
            content = Align.center(
                Text("\nConnected — waiting for chat messages...\n", style="yellow italic"),
                vertical="middle",
            )
            return Panel(content, title="💬 Live Chat Preview (LIVE)", box=box.ROUNDED, style="green")

        lines = Text()
        for msg in recent_chat[-10:]:
            author = msg.get("author", "user")
            text = msg.get("text", "")
            is_hype = bool(msg.get("isHype", False))
            is_trigger = bool(msg.get("isTrigger", False))
            ts_ms = msg.get("timestampMs", 0)
            t_str = datetime.fromtimestamp(ts_ms / 1000).strftime("%H:%M:%S") if ts_ms else "--:--:--"
            lines.append(f"{t_str} ", style="dim")
            if is_trigger:
                lines.append("🎯 ", style="bold green")
            elif is_hype:
                lines.append("🔥 ", style="bold red")
            lines.append(f"{author}: ", style="bold cyan" if not is_hype else "bold magenta")
            lines.append(f"{text[:85]}\n", style="white" if not is_hype else "bold yellow")

        return Panel(lines, title=f"💬 Live Chat Preview ({len(recent_chat)} msgs)", box=box.ROUNDED, style="green")

    def make_footer(self) -> Panel:
        line1 = Text.assemble(
            ("[S] ", "bold yellow"), ("Stream  ", "white"),
            ("[X] ", "bold red"), ("Stop  ", "white"),
            ("[SPACE/C] ", "bold green blink"), ("Clip  ", "bold white"),
            ("[M] ", "bold magenta"), ("Studio  ", "white"),
            ("[G] ", "bold white"), ("Gallery  ", "white"),
            ("[P] ", "bold cyan"), ("Presets", "white"),
        )
        line2 = Text.assemble(
            ("\n[L] ", "bold cyan"), ("Layout  ", "white"),
            ("[F] ", "bold blue"), ("Facecam  ", "white"),
            ("[K] ", "bold yellow"), ("Plans/Key  ", "white"),
            ("[U] ", "bold cyan"), ("Upgrade  ", "white"),
            ("[D] ", "bold green"), ("Doctor  ", "white"),
            ("[Q] ", "bold white"), ("Quit", "white"),
        )
        if not HAS_MSVCRT and not (HAS_POSIX_TTY and sys.stdin.isatty()):
            line2.append(" (Non-TTY: use CLI flags)", style="dim")
        status_line = Text(f"\n{self.status_message}", style=self.status_color)
        combined = Text.assemble(line1, line2, status_line)
        return Panel(combined, box=box.ROUNDED, style="green")

    def render(self, status: Dict[str, Any]) -> Layout:
        layout = Layout()
        layout.split_column(
            Layout(name="header", size=4),
            Layout(name="middle", size=13),
            Layout(name="clips", size=7),
            Layout(name="footer", size=6),
        )
        layout["middle"].split_row(
            Layout(name="monitor", ratio=6),
            Layout(name="chat", ratio=4),
        )
        layout["header"].update(self.make_header(status))
        layout["monitor"].update(self.make_live_monitor_panel(status))
        layout["chat"].update(self.make_live_chat_panel(status))
        layout["clips"].update(self.make_clips_panel(status))
        layout["footer"].update(self.make_footer())
        return layout

    def _prompt_choice(self, title: str, options: List[Tuple[str, str]], default_idx: int = 0) -> int:
        self.console.print(f"\n[bold]{title}[/bold]")
        for i, (_, desc) in enumerate(options, 1):
            marker = "*" if (i - 1) == default_idx else " "
            self.console.print(f"  {marker}[{i}] {desc}")
        raw = self.console.input(f"Choose [1-{len(options)}, default={default_idx + 1}]: ").strip()
        try:
            idx = int(raw) - 1 if raw else default_idx
            if 0 <= idx < len(options):
                return idx
        except ValueError:
            pass
        return default_idx

    @staticmethod
    def _find_option_index(options: List[Tuple[str, str]], key: str, fallback: int = 0) -> int:
        norm = str(key or "").strip().lower()
        for idx, (val, _) in enumerate(options):
            if val.lower() == norm:
                return idx
        return fallback

    def _apply_preset_to_tui(self, preset: Dict[str, Any]) -> Dict[str, Any]:
        layout = str(preset.get("layout") or "split")
        facecam = str(preset.get("facecam_position") or preset.get("facecamPosition") or "auto")
        caption_style = str(preset.get("caption_style") or preset.get("captionStyle") or "none")
        silence_cut = bool(preset.get("silence_cut") if preset.get("silence_cut") is not None else preset.get("silenceCut", False))
        audio_normalize = bool(preset.get("audio_normalize") if preset.get("audio_normalize") is not None else preset.get("audioNormalize", False))
        music_track = str(preset.get("music_track") or preset.get("musicTrack") or "")
        raw_vol = preset.get("music_volume") if preset.get("music_volume") is not None else preset.get("musicVolume")
        music_volume = float(raw_vol) if raw_vol is not None else 0.18
        hook_title = str(preset.get("hook_title") or preset.get("hookTitle") or "")
        watermark_text = str(preset.get("watermark_text") or preset.get("watermarkText") or "")

        self.layout_idx = self._find_option_index(LAYOUT_OPTIONS, layout, self.layout_idx)
        self.facecam_idx = self._find_option_index(FACECAM_OPTIONS, facecam, self.facecam_idx)
        self.caption_idx = self._find_option_index(CAPTION_OPTIONS, caption_style, self.caption_idx)
        return {
            "layout": LAYOUT_OPTIONS[self.layout_idx][0],
            "facecam": FACECAM_OPTIONS[self.facecam_idx][0],
            "caption_style": CAPTION_OPTIONS[self.caption_idx][0],
            "trim_silence": silence_cut,
            "audio_normalize": audio_normalize,
            "music_path": music_track,
            "music_volume": music_volume,
            "hook_title": hook_title,
            "watermark_text": watermark_text,
        }

    def _prompt_export_extras(
        self,
        ask_triggers: bool = False,
        ask_save_rec: bool = False,
        ask_music: bool = False,
        ask_silence: bool = False,
    ) -> Dict[str, Any]:
        preset_defaults: Optional[Dict[str, Any]] = None
        presets = self.client.list_presets(raise_on_error=False)
        if presets:
            self.console.print("\n[bold cyan]⚡ Saved Export Presets (Optional):[/bold cyan]")
            self.console.print("   [0] Custom / Configure manually")
            for idx, pr in enumerate(presets[:15], 1):
                custom_tag = " ★" if pr.get("is_builtin") in (0, False) else ""
                cap_str = pr.get("caption_style") or pr.get("captionStyle") or "none"
                self.console.print(
                    f"   [{idx}] {pr.get('name', 'Preset')}{custom_tag} "
                    f"([dim]{pr.get('layout', 'split')}, captions={cap_str}[/dim])"
                )
            p_sel = self.console.input(f"Choose preset [0-{len(presets[:15])}, default=0]: ").strip()
            if p_sel.isdigit() and 1 <= int(p_sel) <= len(presets[:15]):
                chosen_preset = presets[int(p_sel) - 1]
                preset_defaults = self._apply_preset_to_tui(chosen_preset)
                self.console.print(f"[green]✅ Loaded preset: {chosen_preset.get('name')}[/green]")
                direct = self.console.input("Apply preset settings directly without manual prompts? [Y/n]: ").strip().lower()
                if direct not in ("n", "no"):
                    triggers_direct: List[str] = []
                    if ask_triggers:
                        trig_raw = self.console.input(
                            "\nCustom chat trigger keywords (comma-separated, e.g. !clip,clip it, blank=default): "
                        ).strip()
                        triggers_direct = [k.strip() for k in trig_raw.split(",") if k.strip()]
                    save_rec_direct = False
                    if ask_save_rec:
                        rec_in = self.console.input(
                            "Save full stream recording (05_streams/) for after-live clipping? [y/N]: "
                        ).strip().lower()
                        save_rec_direct = rec_in in ("y", "yes")
                    return {
                        **preset_defaults,
                        "triggers": triggers_direct,
                        "save_recording": save_rec_direct,
                    }

        self.layout_idx = self._prompt_choice("Select Layout:", LAYOUT_OPTIONS, self.layout_idx)
        self.facecam_idx = self._prompt_choice("Select Facecam Mode:", FACECAM_OPTIONS, self.facecam_idx)
        self.caption_idx = self._prompt_choice("Select Auto-Captions:", CAPTION_OPTIONS, self.caption_idx)

        triggers: List[str] = []
        if ask_triggers:
            trig_raw = self.console.input(
                "\nCustom chat trigger keywords (comma-separated, e.g. !clip,clip it, blank=default): "
            ).strip()
            triggers = [k.strip() for k in trig_raw.split(",") if k.strip()]

        default_hook = (preset_defaults or {}).get("hook_title", "")
        hook_prompt = f"\nOptional Hook Headline overlay (blank={default_hook or 'none'}): "
        hook_title = self.console.input(hook_prompt).strip() or default_hook

        default_norm = bool((preset_defaults or {}).get("audio_normalize", False))
        norm_prompt = "Enable -14 LUFS broadcast audio normalize? [Y/n]: " if default_norm else "Enable -14 LUFS broadcast audio normalize? [y/N]: "
        norm_in = self.console.input(norm_prompt).strip().lower()
        audio_normalize = (norm_in not in ("n", "no")) if default_norm else (norm_in in ("y", "yes"))

        trim_silence = False
        if ask_silence:
            default_sil = bool((preset_defaults or {}).get("trim_silence", False))
            sil_prompt = "Trim dead-air silence pauses? [Y/n]: " if default_sil else "Trim dead-air silence pauses? [y/N]: "
            sil_in = self.console.input(sil_prompt).strip().lower()
            trim_silence = (sil_in not in ("n", "no")) if default_sil else (sil_in in ("y", "yes"))

        music_path = (preset_defaults or {}).get("music_path", "")
        music_volume = float((preset_defaults or {}).get("music_volume", 0.18))
        if ask_music:
            tracks = self.client.get_music_tracks()
            if tracks:
                self.console.print("\n[bold]Background Music (06_music/):[/bold]")
                self.console.print("   [0] None (No background music)")
                for idx, tr in enumerate(tracks[:15], 1):
                    self.console.print(f"   [{idx}] 🎵 {tr.get('name', tr.get('title', 'track'))}")
                m_sel = self.console.input(f"Choose music track [0-{len(tracks[:15])}, blank=keep preset/none]: ").strip()
                if m_sel == "0":
                    music_path = ""
                elif m_sel.isdigit() and 1 <= int(m_sel) <= len(tracks[:15]):
                    music_path = tracks[int(m_sel) - 1].get("path", "")
                    vol_raw = self.console.input(f"Music mix volume (0.05–0.50, default={music_volume:.2f}): ").strip()
                    if vol_raw:
                        try:
                            music_volume = max(0.02, min(1.0, float(vol_raw)))
                        except ValueError:
                            pass

        default_wm = (preset_defaults or {}).get("watermark_text", "")
        watermark_text = self.console.input(
            f"Optional custom watermark (@handle, Ultra plan, blank={default_wm or 'default'}): "
        ).strip() or default_wm

        save_recording = False
        if ask_save_rec:
            rec_in = self.console.input("Save full stream recording (05_streams/) for after-live clipping? [y/N]: ").strip().lower()
            save_recording = rec_in in ("y", "yes")

        return {
            "layout": LAYOUT_OPTIONS[self.layout_idx][0],
            "facecam": FACECAM_OPTIONS[self.facecam_idx][0],
            "caption_style": CAPTION_OPTIONS[self.caption_idx][0],
            "triggers": triggers,
            "hook_title": hook_title,
            "audio_normalize": audio_normalize,
            "trim_silence": trim_silence,
            "music_path": music_path,
            "music_volume": music_volume,
            "watermark_text": watermark_text,
            "save_recording": save_recording,
        }

    def prompt_start(self) -> None:
        """Interactive prompt in terminal to configure and start stream."""
        self.console.clear()
        self.console.print("\n[bold magenta]🚀 Start Live Stream Clipper[/bold magenta]\n")

        self.console.print("[bold]1. Select Platform:[/bold]")
        self.console.print("   [1] Twitch")
        self.console.print("   [2] Kick")
        self.console.print("   [3] YouTube")
        plat_choice = self.console.input("Choose platform [1-3, default=1]: ").strip()
        platform = "kick" if plat_choice == "2" else ("youtube" if plat_choice == "3" else "twitch")

        channel = self.console.input(f"Enter {platform.upper()} channel name or stream URL: ").strip()
        if not channel:
            self.status_message = "Cancelled start: no channel provided."
            self.status_color = "red"
            return

        opts = self._prompt_export_extras(ask_triggers=True, ask_save_rec=True)

        self.console.print(f"\n[bold yellow]Connecting to {platform}: {channel}...[/bold yellow]")
        try:
            res = self.client.start_session(
                platform=platform,
                channel=channel,
                layout=opts["layout"],
                facecam=opts["facecam"],
                caption_style=opts["caption_style"],
                watermark_text=opts["watermark_text"],
                hook_title=opts["hook_title"],
                audio_normalize=opts["audio_normalize"],
                trigger_keywords=opts["triggers"] or None,
                save_recording=opts["save_recording"],
            )
            if res.get("ok"):
                self.status_message = f"✅ Started monitoring {platform}: {channel}"
                self.status_color = "bold green"
            else:
                formatted = self._format_api_error(res, "Error starting")
                self.console.print(Text(formatted, style="bold yellow" if res.get("upgrade_required") else "bold red"))
                self.console.input("Press [Enter] to return...")
        except Exception as exc:
            self.status_message = f"❌ Connection failed: {exc}"
            self.status_color = "bold red"

    @staticmethod
    def parse_time_input(val: str) -> float:
        s = val.strip()
        if not s:
            return 0.0
        parts = s.split(":")
        try:
            if len(parts) == 1:
                return float(parts[0])
            if len(parts) == 2:
                return float(parts[0]) * 60 + float(parts[1])
            if len(parts) == 3:
                return float(parts[0]) * 3600 + float(parts[1]) * 60 + float(parts[2])
        except ValueError:
            return 0.0
        return 0.0

    def prompt_license_manager(self) -> None:
        """[K] Stripe Subscription & Plans Manager."""
        while True:
            self.console.clear()
            self.console.print("\n[bold magenta]💎 Stripe Billing & SaaS Plans[/bold magenta]\n")
            try:
                billing = self.client.get_billing_status(raise_on_error=True)
                self.billing_cache = billing
            except Exception as exc:
                self.console.print(Text(f"❌ Could not fetch billing status: {exc}", style="bold red"))
                self.console.input("\nPress [Enter] to return...")
                self.status_message = f"❌ Billing check failed: {exc}"
                self.status_color = "bold red"
                return

            ent = billing.get("entitlement", {})
            plan = ent.get("plan", {})
            lic = ent.get("license", {})
            usage = ent.get("usage", {})

            used = usage.get("usedToday", 0)
            limit = usage.get("dailyLimit", 3)
            unlimited = bool(usage.get("unlimited", False)) or limit < 0
            quota_str = f"{used} clips today (Unlimited)" if unlimited else f"{used} / {limit} daily clips used"

            summary = Text.assemble(
                ("Active Plan:  ", "bold"), (f"{plan.get('name', 'Free Starter')} ({str(plan.get('id', 'free')).upper()})\n", "bold cyan"),
                ("Max Quality:  ", "bold"), (f"{plan.get('max_resolution', 720)}p\n", "green"),
                ("Daily Quota:  ", "bold"), (f"{quota_str}\n", "yellow"),
                ("Provider:     ", "bold"), (f"{str(lic.get('provider', 'free')).upper()}\n", "white"),
                ("License Key:  ", "bold"), (f"{lic.get('maskedKey') or 'None (Free Tier)'}", "dim"),
            )
            if lic.get("customer_email"):
                summary.append(f"\nEmail:        {lic.get('customer_email')}", style="dim")
            self.console.print(Panel(summary, title="Current Workstation Entitlement", box=box.ROUNDED, style="blue"))

            plans = billing.get("plans", [])
            ptable = Table(title="Available Plans", box=box.ROUNDED)
            ptable.add_column("ID", style="bold cyan", width=8)
            ptable.add_column("Name", style="bold white")
            ptable.add_column("Price", justify="right", style="green")
            ptable.add_column("Quota", justify="right", style="yellow")
            ptable.add_column("Res", justify="right", style="cyan")
            ptable.add_column("Unlocked Features", style="dim")

            for p in plans:
                price_usd = float(p.get("price_usd", 0))
                period_raw = str(p.get("billing_period", "MONTHLY")).upper()
                amt_str = f"${price_usd:.0f}" if price_usd.is_integer() else f"${price_usd:.2f}"
                if price_usd <= 0:
                    price_str = "Free"
                elif period_raw == "ONE_TIME":
                    price_str = f"{amt_str} lifetime"
                elif period_raw == "YEARLY":
                    price_str = f"{amt_str}/yr"
                else:
                    price_str = f"{amt_str}/mo"
                lim = int(p.get("daily_clip_limit", 3))
                q_str = "Unlimited" if lim < 0 else f"{lim}/day"
                feats = []
                if not p.get("watermark_enabled"):
                    feats.append("No Watermark")
                if p.get("allow_auto_captions"):
                    feats.append("Captions")
                if p.get("allow_audio_peak"):
                    feats.append("Audio Peak AI")
                if p.get("allow_virality_ai"):
                    feats.append("Virality Score")
                if p.get("allow_watchlist"):
                    feats.append("Watchlist")
                if p.get("allow_custom_branding"):
                    feats.append("Custom Brand")
                ptable.add_row(
                    str(p.get("id", "")).upper(),
                    str(p.get("name", "")),
                    price_str,
                    q_str,
                    f"{p.get('max_resolution', 720)}p",
                    ", ".join(feats) or "Basic 720p clipping",
                )
            self.console.print(ptable)

            self.console.print("\n[bold cyan]Actions:[/bold cyan]")
            self.console.print("  [1] 🔑 Paste & Activate License Key (Stripe sub_/cs_ or Admin VIP)")
            self.console.print("  [2] 💳 Get Stripe Checkout Link (Pro / Ultra)")
            if str(plan.get("id", "free")) != "free":
                self.console.print("  [3] 🔓 Deactivate Current License")
            self.console.print("  [Enter] Return to Dashboard")

            choice = self.console.input("\nSelect action: ").strip()
            if not choice:
                return
            if choice == "1":
                key = self.console.input("Paste License Key: ").strip()
                if not key:
                    continue
                try:
                    res = self.client.activate_license(key)
                    if res.get("ok"):
                        new_plan = res.get("entitlement", {}).get("plan", {}).get("name", "Paid Plan")
                        self._refresh_billing_cache(force=True)
                        self.status_message = f"✅ License activated: {new_plan}"
                        self.status_color = "bold green"
                        self.console.print(f"\n[bold green]✅ Activated {new_plan}![/bold green]")
                    else:
                        msg = self._format_api_error(res, "Activation failed")
                        self.console.print(Text(f"\n{msg}", style="bold red"))
                except Exception as exc:
                    self.console.print(Text(f"\n❌ Activation error: {exc}", style="bold red"))
                self.console.input("Press [Enter] to continue...")
            elif choice == "2":
                tier = (self.console.input("Plan to checkout [pro / ultra, default=pro]: ").strip().lower() or "pro")
                email = self.console.input("Customer email (optional): ").strip()
                try:
                    res = self.client.create_checkout(tier, email)
                    if res.get("ok") and res.get("checkoutUrl"):
                        url = res["checkoutUrl"]
                        self.console.print(f"\n[bold green]💳 Stripe Checkout URL:[/bold green] {url}")
                        open_now = self.console.input("Open checkout link in browser now? [Y/n]: ").strip().lower()
                        if open_now not in ("n", "no"):
                            webbrowser.open(url)
                        self.console.print("[dim]After payment, paste your Stripe cs_/sub_ ID or license key with option [1].[/dim]")
                    else:
                        msg = self._format_api_error(res, "Checkout error")
                        self.console.print(Text(f"\n{msg}", style="bold red"))
                except Exception as exc:
                    self.console.print(Text(f"\n❌ Checkout failed: {exc}", style="bold red"))
                self.console.input("Press [Enter] to continue...")
            elif choice == "3" and str(plan.get("id", "free")) != "free":
                confirm = self.console.input("Deactivate current license and revert to Free? [y/N]: ").strip().lower()
                if confirm in ("y", "yes"):
                    try:
                        res = self.client.deactivate_license()
                        if res.get("ok"):
                            self._refresh_billing_cache(force=True)
                            self.status_message = "License deactivated. Reverted to Free tier."
                            self.status_color = "yellow"
                            self.console.print("[yellow]License deactivated.[/yellow]")
                        else:
                            self.console.print(Text(self._format_api_error(res, "Deactivate failed"), style="bold red"))
                    except Exception as exc:
                        self.console.print(Text(f"❌ Error: {exc}", style="bold red"))
                    self.console.input("Press [Enter] to continue...")

    def _select_studio_source(self) -> Tuple[str, str, str]:
        self.console.print("  [1] Select from saved stream recordings / local videos")
        self.console.print("  [2] Browse channel past live broadcasts (Twitch / Kick / YouTube)")
        self.console.print("  [3] Enter custom local file path or direct VOD/stream URL")
        src_mode = self.console.input("\nChoose source [1-3, default=1]: ").strip() or "1"

        chosen_source = ""
        chosen_stream_url = ""
        chosen_title = ""

        if src_mode == "1":
            videos = self.client.get_local_videos()
            if not videos:
                self.console.print("[yellow]No local videos found in ClipperMedia folders.[/yellow]")
                chosen_source = self.console.input("Enter video file path instead: ").strip()
            else:
                t = Table(title="Local Videos & Recordings", box=box.ROUNDED)
                t.add_column("#", width=4, style="cyan")
                t.add_column("Folder", width=12, style="magenta")
                t.add_column("Filename", style="bold white")
                t.add_column("Size", justify="right", style="yellow")
                for i, v in enumerate(videos[:20], 1):
                    t.add_row(str(i), v.get("folder", ""), v.get("name", ""), f"{v.get('sizeBytes', 0)/1e6:.1f} MB")
                self.console.print(t)
                sel = self.console.input("Select video # (or press Enter to cancel): ").strip()
                if sel.isdigit() and 1 <= int(sel) <= len(videos[:20]):
                    chosen_source = videos[int(sel) - 1]["path"]
        elif src_mode == "2":
            self.console.print("\n   [1] Twitch  [2] Kick  [3] YouTube")
            p_in = self.console.input("Choose platform [1-3, default=1]: ").strip()
            plat = "kick" if p_in == "2" else ("youtube" if p_in == "3" else "twitch")
            ch = self.console.input(f"Enter {plat.upper()} channel name: ").strip()
            if not ch:
                return "", "", ""
            self.console.print(f"[dim]Loading past broadcasts for {ch}...[/dim]")
            try:
                streams = self.client.get_past_streams(plat, ch)
                if not streams:
                    self.console.print("[yellow]No past broadcasts found.[/yellow]")
                    self.console.input("Press Enter to return...")
                    return "", "", ""
                t = Table(title=f"Past Live Streams ({plat}: {ch})", box=box.ROUNDED)
                t.add_column("#", width=4, style="cyan")
                t.add_column("Title", style="bold white")
                t.add_column("Duration", width=10, style="green")
                t.add_column("Date", width=12, style="dim")
                for i, st in enumerate(streams, 1):
                    dur_s = int(st.get("durationSec", 0))
                    h, m, s = dur_s // 3600, (dur_s % 3600) // 60, dur_s % 60
                    dur_str = f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"
                    t.add_row(str(i), st.get("title", "")[:60], dur_str, st.get("createdAt", "")[:10])
                self.console.print(t)
                sel = self.console.input("Select stream # to clip (or Enter to cancel): ").strip()
                if sel.isdigit() and 1 <= int(sel) <= len(streams):
                    picked = streams[int(sel) - 1]
                    chosen_source = picked.get("url", "")
                    chosen_stream_url = picked.get("streamUrl", "")
                    chosen_title = picked.get("title", "")
            except Exception as exc:
                self.status_message = f"❌ Stream lookup failed: {exc}"
                self.status_color = "red"
                return "", "", ""
        else:
            chosen_source = self.console.input("Enter local file path or VOD/stream URL: ").strip()

        return chosen_source, chosen_stream_url, chosen_title

    def _run_studio_batch_autoclip(
        self,
        chosen_source: str,
        chosen_stream_url: str,
        top_n: int = 3,
    ) -> None:
        opts = self._prompt_export_extras(ask_music=True, ask_silence=True)
        self.console.print(f"\n[bold yellow]🚀 Scanning & batch auto-clipping top {top_n} moments...[/bold yellow]")
        try:
            res = self.client.auto_clip_batch(
                source=chosen_source,
                top_n=top_n,
                layout=opts["layout"],
                facecam=opts["facecam"],
                caption_style=opts["caption_style"],
                watermark_text=opts["watermark_text"],
                hook_title=opts["hook_title"],
                audio_normalize=opts["audio_normalize"],
                trim_silence=opts["trim_silence"],
                music_path=opts["music_path"],
                music_volume=opts["music_volume"],
                stream_url=chosen_stream_url,
            )
            if res.get("ok"):
                clips = res.get("clips") or res.get("results") or []
                self._refresh_billing_cache(force=True)
                self.status_message = f"✅ Batch auto-clipped {len(clips)} moments!"
                self.status_color = "bold green"
                self.console.print(f"\n[bold green]✅ Rendered {len(clips)} clips:[/bold green]")
                for idx, c in enumerate(clips, 1):
                    fp = c.get("filePath") or c.get("file_path", "")
                    sc = c.get("viralityScore") or c.get("virality_score", 0)
                    self.console.print(f"  [{idx}] {fp} (🔥 {sc}/100)")
                self.console.input("\nPress [Enter] to return...")
            else:
                formatted = self._format_api_error(res, "Batch auto-clip failed")
                self.console.print(Text(formatted, style="bold yellow" if res.get("upgrade_required") else "bold red"))
                self.console.input("Press [Enter] to return...")
        except Exception as exc:
            self.status_message = f"❌ Batch auto-clip error: {exc}"
            self.status_color = "bold red"

    def prompt_after_live_clip(self) -> None:
        """[M] Interactive After-Live / VOD Studio & Audio Peak Hype Scanner Wizard."""
        self.console.clear()
        self.console.print("\n[bold magenta]✂ After-Live / Manual Video & Stream Studio[/bold magenta]\n")

        chosen_source, chosen_stream_url, chosen_title = self._select_studio_source()
        if not chosen_source:
            if not self.status_message.startswith("❌"):
                self.status_message = "After-live manual clip cancelled."
                self.status_color = "yellow"
            return

        self.console.print("\n[bold]Studio Action Mode:[/bold]")
        self.console.print("  [1] ⚡ Scan Audio Peaks (find loudest hype moments & pick one)")
        self.console.print("  [2] 🚀 Batch Auto-Clip Top 3 Moments (auto-scan + render top 3)")
        self.console.print("  [3] ✂ Custom Start / End Cut (with captions, normalize, music, hook)")
        mode = self.console.input("\nChoose mode [1-3, default=3]: ").strip() or "3"

        start_sec = 0.0
        end_sec = 25.0
        audio_delta_db = 0.0

        if mode == "2":
            n_raw = self.console.input("How many top moments to auto-clip? [default=3]: ").strip()
            top_n = max(1, min(10, int(n_raw))) if n_raw.isdigit() else 3
            self._run_studio_batch_autoclip(chosen_source, chosen_stream_url, top_n=top_n)
            return

        if mode == "1":
            self.console.print("\n[bold yellow]⚡ Scanning audio loudness for hype spikes...[/bold yellow]")
            try:
                scan = self.client.scan_audio_peaks(chosen_source, stream_url=chosen_stream_url, clip_duration_sec=25)
                if not scan.get("ok"):
                    formatted = self._format_api_error(scan, "Audio peak scan failed")
                    self.console.print(Text(formatted, style="bold yellow" if scan.get("upgrade_required") else "bold red"))
                    self.console.input("Press [Enter] to return...")
                    return

                peaks = scan.get("peaks", [])
                if not peaks:
                    self.console.print("[yellow]No loud audio peaks found above baseline. Switching to custom cut.[/yellow]")
                else:
                    pt = Table(
                        title=f"⚡ Detected Hype Peaks (Avg {scan.get('avgDb', -40)} dB • Scanned {scan.get('scannedDurationSec', 0)}s)",
                        box=box.ROUNDED,
                    )
                    pt.add_column("#", width=4, style="cyan")
                    pt.add_column("Start → End", width=16, style="green")
                    pt.add_column("Delta", justify="right", style="yellow", width=10)
                    pt.add_column("🔥 Score", justify="right", style="magenta", width=9)
                    pt.add_column("Reason", style="dim")

                    for i, pk in enumerate(peaks, 1):
                        pt.add_row(
                            str(i),
                            f"{pk.get('startSec', 0):.1f}s → {pk.get('endSec', 25):.1f}s",
                            f"+{pk.get('deltaDb', 0):.1f} dB",
                            f"🔥 {pk.get('viralityScore', 0)}",
                            str(pk.get("reason", "")),
                        )
                    self.console.print(pt)
                    pick = self.console.input("Pick peak # (or 'b' to Batch Auto-Clip Top 3, Enter for custom): ").strip().lower()
                    if pick == "b":
                        self._run_studio_batch_autoclip(chosen_source, chosen_stream_url, top_n=3)
                        return
                    if pick.isdigit() and 1 <= int(pick) <= len(peaks):
                        chosen_pk = peaks[int(pick) - 1]
                        start_sec = float(chosen_pk.get("startSec", 0.0))
                        end_sec = float(chosen_pk.get("endSec", start_sec + 25.0))
                        audio_delta_db = float(chosen_pk.get("deltaDb", 0.0))
                        if not chosen_title:
                            chosen_title = f"audio_peak_{int(pick)}"
            except Exception as exc:
                formatted = f"❌ Audio peak scan error: {exc}"
                self.status_message = formatted
                self.status_color = "bold red"
                self.console.print(Text(formatted, style="bold red"))
                self.console.input("Press [Enter] to return...")
                return

        if mode != "1" or audio_delta_db == 0.0:
            start_raw = self.console.input("\nStart timestamp (seconds or MM:SS, default=0:00): ").strip() or "0"
            start_sec = self.parse_time_input(start_raw)
            end_raw = self.console.input(f"End timestamp (seconds or MM:SS, default={start_sec + 25:.0f}): ").strip()
            end_sec = self.parse_time_input(end_raw) if end_raw else (start_sec + 25.0)
            if end_sec <= start_sec:
                end_sec = start_sec + 25.0

        clip_title = self.console.input("Clip title (optional, default auto): ").strip() or chosen_title
        opts = self._prompt_export_extras(ask_music=True, ask_silence=True)

        self.console.print(
            f"\n[bold yellow]⏳ Rendering clip ({start_sec:.1f}s → {end_sec:.1f}s, "
            f"layout={opts['layout']}, captions={opts['caption_style']})...[/bold yellow]"
        )
        try:
            res = self.client.cut_manual_clip(
                source=chosen_source,
                start_sec=start_sec,
                end_sec=end_sec,
                layout=opts["layout"],
                facecam=opts["facecam"],
                title=clip_title,
                stream_url=chosen_stream_url,
                caption_style=opts["caption_style"],
                watermark_text=opts["watermark_text"],
                hook_title=opts["hook_title"],
                audio_normalize=opts["audio_normalize"],
                trim_silence=opts["trim_silence"],
                music_path=opts["music_path"],
                music_volume=opts["music_volume"],
                audio_delta_db=audio_delta_db,
            )
            if res.get("ok"):
                clip_obj = res.get("clip", {})
                fpath = clip_obj.get("filePath", "")
                score = clip_obj.get("viralityScore", 0)
                self._refresh_billing_cache(force=True)
                self.status_message = f"✅ Rendered: {os.path.basename(fpath)} (🔥 {score}/100)"
                self.status_color = "bold green"
            else:
                formatted = self._format_api_error(res, "Clip failed")
                self.console.print(Text(formatted, style="bold yellow" if res.get("upgrade_required") else "bold red"))
                self.console.input("Press [Enter] to return...")
        except Exception as exc:
            self.status_message = f"❌ Clip error: {exc}"
            self.status_color = "bold red"

    def _reexport_clip_wizard(self, clip: Dict[str, Any]) -> bool:
        """Interactive Trim / Speed / Flip / Polish Re-Export wizard for a gallery clip."""
        clip_id = str(clip.get("id") or "")
        if not clip_id:
            return False
        dur = float(clip.get("duration_sec") or 20.0)
        self.console.print(f"\n[bold magenta]♻️ Re-Export Wizard:[/bold magenta] {clip.get('title', 'clip')} ({dur:.1f}s)")
        payload: Dict[str, Any] = {}

        t_start_raw = self.console.input("Trim start seconds (blank=0): ").strip()
        if t_start_raw:
            try:
                t_start = max(0.0, float(t_start_raw))
                payload["trimStartSec"] = t_start
            except ValueError:
                self.console.print("[yellow]Invalid start seconds — keeping 0.[/yellow]")

        t_end_raw = self.console.input(f"Trim end seconds (blank=full {dur:.1f}s): ").strip()
        if t_end_raw:
            try:
                t_end = max(0.0, float(t_end_raw))
                if t_end > 0:
                    payload["trimEndSec"] = t_end
            except ValueError:
                self.console.print("[yellow]Invalid end seconds — keeping full end.[/yellow]")

        speed_raw = self.console.input("Playback speed 0.5-2.0 (blank=1.0): ").strip()
        if speed_raw:
            try:
                spd = float(speed_raw)
                if 0.5 <= spd <= 2.0:
                    payload["speed"] = spd
                else:
                    self.console.print("[yellow]Speed must be 0.5-2.0 — keeping 1.0.[/yellow]")
            except ValueError:
                self.console.print("[yellow]Invalid speed — keeping 1.0.[/yellow]")

        flip_raw = self.console.input("Flip horizontal? [y/N]: ").strip().lower()
        if flip_raw in ("y", "yes"):
            payload["flipHorizontal"] = True

        cap_raw = self.console.input("Captions (none/hormozi/neon/minimal, blank=skip): ").strip().lower()
        if cap_raw:
            if cap_raw in ("none", "hormozi", "neon", "minimal"):
                payload["captionStyle"] = cap_raw
            else:
                self.console.print("[yellow]Unknown caption style — skipping.[/yellow]")

        tracks = self.client.get_music_tracks()
        if tracks:
            self.console.print("\n[bold]Optional Background Music (06_music/):[/bold]")
            self.console.print("   [0] None / Skip")
            for tidx, tr in enumerate(tracks[:10], 1):
                self.console.print(f"   [{tidx}] 🎵 {tr.get('name', tr.get('title', 'track'))}")
            msel = self.console.input(f"Choose music track [0-{len(tracks[:10])}, default=0]: ").strip()
            if msel.isdigit() and 1 <= int(msel) <= len(tracks[:10]):
                payload["musicTrack"] = tracks[int(msel) - 1].get("path", "")
                vol_raw = self.console.input("Music volume (0.05-0.50, default=0.18): ").strip()
                try:
                    payload["musicVolume"] = max(0.02, min(1.0, float(vol_raw))) if vol_raw else 0.18
                except ValueError:
                    payload["musicVolume"] = 0.18
        else:
            m_raw = self.console.input("Background music track path/name (blank=none): ").strip()
            if m_raw:
                payload["musicTrack"] = m_raw
                payload["musicVolume"] = 0.18

        self.console.print("\n[bold yellow]♻️ Re-exporting clip...[/bold yellow]")
        try:
            res = self.client.reexport_clip(clip_id, payload)
            if res.get("ok"):
                clip_obj = res.get("clip") or res
                fp = clip_obj.get("filePath") or clip_obj.get("file_path") or ""
                self.status_message = f"✅ Re-exported: {os.path.basename(str(fp)) or clip_id[:8]}"
                self.status_color = "bold green"
                self.console.print(f"[bold green]✅ Re-exported clip saved:[/bold green] {fp}")
                self.console.input("Press [Enter] to continue...")
                return True
            msg = self._format_api_error(res, "Re-export failed")
            self.console.print(Text(msg, style="bold yellow" if res.get("upgrade_required") else "bold red"))
        except Exception as exc:
            self.console.print(Text(f"❌ Re-export error: {exc}", style="bold red"))
        self.console.input("Press [Enter] to continue...")
        return False

    def _queue_clip_upload_wizard(self, clip: Dict[str, Any]) -> None:
        """Interactive prompt to add a gallery clip to the Social Upload Queue."""
        clip_id = str(clip.get("id") or "")
        if not clip_id:
            return
        platforms = ["youtube", "tiktok", "instagram", "twitter", "twitch_clips"]
        self.console.print("\n[bold cyan]📤 Add Clip to Social Upload Queue:[/bold cyan]")
        self.console.print("  [1] youtube  [2] tiktok  [3] instagram  [4] twitter  [5] twitch_clips")
        plat_raw = self.console.input("Choose platform [1-5, default=1]: ").strip().lower()
        if plat_raw in ("1", "2", "3", "4", "5"):
            platform = platforms[int(plat_raw) - 1]
        elif plat_raw in platforms:
            platform = plat_raw
        else:
            platform = "youtube"

        default_title = str(clip.get("social_title") or clip.get("title") or "Clip").strip()[:140]
        title = self.console.input(f"Post title (blank='{default_title[:45]}'): ").strip()[:140] or default_title
        default_tags = str(clip.get("social_hashtags") or clip.get("tags") or "").strip()[:500]
        tags = self.console.input(f"Tags/hashtags (blank='{default_tags[:40]}'): ").strip()[:500] or default_tags

        try:
            res = self.client.add_to_upload_queue(clip_id=clip_id, platform=platform, title=title, tags=tags)
            if res.get("ok"):
                self.status_message = f"📤 Queued '{title[:32]}' → {platform}"
                self.status_color = "bold green"
                self.console.print(f"[bold green]✅ Added to {platform.upper()} upload queue![/bold green]")
            else:
                self.console.print(Text(self._format_api_error(res, "Queue error"), style="bold red"))
        except Exception as exc:
            self.console.print(Text(f"❌ Queue error: {exc}", style="bold red"))
        self.console.input("Press [Enter] to continue...")

    def _batch_metadata_gallery(self, tokens_str: str, filtered: List[Dict[str, Any]]) -> bool:
        """Runs batch AI metadata generation for selected gallery clip numbers (max 20)."""
        raw_nums = [x.strip() for x in tokens_str.replace(",", " ").split() if x.strip()]
        selected_ids: List[str] = []
        seen: set[str] = set()
        for token in raw_nums:
            if token.isdigit():
                idx = int(token) - 1
                if 0 <= idx < len(filtered):
                    cid = str(filtered[idx].get("id") or "")
                    if cid and cid not in seen:
                        seen.add(cid)
                        selected_ids.append(cid)
        if not selected_ids:
            self.console.print("[yellow]Specify valid clip numbers, e.g. bmeta 1,2,3[/yellow]")
            self.console.input("Press [Enter] to continue...")
            return False
        if len(selected_ids) > 20:
            self.console.print("[yellow]Batch AI metadata supports at most 20 clips — using first 20.[/yellow]")
            selected_ids = selected_ids[:20]

        self.console.print(f"\n[bold yellow]🤖 Generating AI metadata for {len(selected_ids)} clip(s)...[/bold yellow]")
        try:
            res = self.client.batch_metadata(selected_ids)
            if res.get("ok"):
                updated = int(res.get("updatedCount", 0))
                self.console.print(f"[bold green]✅ Updated metadata for {updated} clip(s)[/bold green]")
                for item in res.get("results") or []:
                    icon = "✅" if item.get("ok") else "❌"
                    self.console.print(f"  {icon} {item.get('id', '')[:8]} — {item.get('title') or item.get('error', '')}")
                self.status_message = f"🤖 Batch AI metadata updated {updated} clip(s)"
                self.status_color = "bold green"
                self.console.input("\nPress [Enter] to continue...")
                return True
            msg = self._format_api_error(res, "Batch metadata failed")
            self.console.print(Text(msg, style="bold yellow" if res.get("upgrade_required") else "bold red"))
        except Exception as exc:
            self.console.print(Text(f"❌ Batch metadata error: {exc}", style="bold red"))
        self.console.input("Press [Enter] to continue...")
        return False

    def show_gallery(self) -> None:
        """[G] Interactive Clips Gallery with Virality scores, ratings, favourites, tags, notes, re-export & upload queue."""
        search_query = ""
        min_score = 0.0
        fav_only = False
        clips = self.client.get_clips()

        while True:
            self.console.clear()
            if not clips:
                self.console.print(f"\n[bold yellow]No clips rendered yet in {MEDIA_CLIPS_DIR}[/bold yellow]\n")
                self.console.input("Press [Enter] to return...")
                return

            filtered = [
                c for c in clips
                if (
                    not search_query
                    or search_query in f"{c.get('title', '')} {c.get('social_title', '')} {c.get('tags', '')}".lower()
                )
                and float(c.get("virality_score") or 0) >= min_score
                and (not fav_only or int(c.get("is_favourite") or 0) == 1)
            ]

            filter_note = []
            if search_query:
                filter_note.append(f"search='{search_query}'")
            if min_score > 0:
                filter_note.append(f"score>={int(min_score)}")
            if fav_only:
                filter_note.append("⭐ favourites")
            title_suffix = f" ({', '.join(filter_note)})" if filter_note else ""

            table = Table(title=f"📁 Clipper Studio Gallery{title_suffix}", box=box.ROUNDED, expand=True)
            table.add_column("#", justify="right", style="cyan", width=3, no_wrap=True)
            table.add_column("⭐", justify="center", width=2, no_wrap=True)
            table.add_column("★", justify="center", width=5, no_wrap=True)
            table.add_column("Title", style="bold white", min_width=14, ratio=3)
            table.add_column("Tags / Notes", style="cyan", min_width=10, ratio=2)
            table.add_column("🔥 Score", justify="right", min_width=6)
            table.add_column("Duration", justify="right", style="green", min_width=7)
            table.add_column("Size", justify="right", style="yellow", min_width=7)
            table.add_column("Layout", style="magenta", min_width=8)
            table.add_column("Date", style="dim", min_width=10)

            for i, c in enumerate(filtered, 1):
                score = float(c.get("virality_score") or 0)
                if score >= 80:
                    score_txt = Text(f"🔥 {int(round(score))}", style="bold green")
                elif score >= 60:
                    score_txt = Text(f"⚡ {int(round(score))}", style="bold yellow")
                elif score > 0:
                    score_txt = Text(f"{int(round(score))}", style="dim")
                else:
                    score_txt = Text("—", style="dim")

                fav_mark = "⭐" if int(c.get("is_favourite") or 0) == 1 else "·"
                raw_rating = c.get("rating")
                if isinstance(raw_rating, (int, float)) and int(raw_rating) >= 1:
                    star_txt = Text("★" * min(5, int(raw_rating)), style="bold yellow")
                else:
                    star_txt = Text("·", style="dim")

                tags_raw = str(c.get("tags") or "").strip()
                notes_raw = str(c.get("notes") or "").strip()
                meta_parts = []
                if tags_raw:
                    meta_parts.append(" ".join(f"#{t.strip()}" for t in tags_raw.split(",") if t.strip()))
                if notes_raw:
                    meta_parts.append(f"📝 {notes_raw[:24]}{'…' if len(notes_raw) > 24 else ''}")
                tags_notes_str = " | ".join(meta_parts) or "—"

                dur = f"{c.get('duration_sec', 20):.1f}s"
                size_mb = f"{c.get('file_size_bytes', 0) / (1024 * 1024):.1f} MB"
                date = c.get("created_at", "")[:10]
                table.add_row(
                    str(i),
                    fav_mark,
                    star_txt,
                    c.get("title", ""),
                    tags_notes_str,
                    score_txt,
                    dur,
                    size_mb,
                    c.get("layout", "split"),
                    date,
                )

            self.console.print(table)
            self.console.print("\n[bold cyan]Gallery Actions:[/bold cyan]")
            self.console.print("  [bold]1[/bold]             Open clip #1 in media player | [bold]e1[/bold] Reveal in file manager")
            self.console.print("  [bold]s1 / *1[/bold]       Toggle ⭐ Favourite | [bold]star1 5[/bold] Rate 1-5 ★ stars")
            self.console.print("  [bold]t1 / n1[/bold]       Edit tags / notes | [bold]m1[/bold] AI Title & #Hashtags")
            self.console.print("  [bold]r1[/bold]            Trim / Speed / Flip Re-Export wizard for clip #1")
            self.console.print("  [bold]k1[/bold]            Save Creator Kit JSON + show summary for clip #1")
            self.console.print("  [bold]u1[/bold]            Queue clip #1 for Social Upload (YT/TikTok/IG/X/Twitch)")
            self.console.print("  [bold]bmeta 1,2,3[/bold]   Batch AI metadata (max 20) | [bold]c 1,2,3[/bold] Compile Montage Reel")
            self.console.print("  [bold]csv[/bold]           Export library to ./clipper_clips_export.csv")
            self.console.print("  [bold]s <query>[/bold]     Search title/tags ('s' to clear) | [bold]fav[/bold] Toggle ⭐ | [bold]f <score>[/bold] Min score")
            self.console.print("  [bold]r[/bold]             Refresh gallery | [bold][Enter][/bold] Return to dashboard\n")

            cmd = self.console.input("Select action: ").strip()
            if not cmd or cmd.lower() == "q":
                return

            if cmd.lower() == "r":
                clips = self.client.get_clips()
                continue

            if cmd.lower().startswith("r") and len(cmd) > 1 and cmd[1:].isdigit():
                idx = int(cmd[1:]) - 1
                if 0 <= idx < len(filtered):
                    if self._reexport_clip_wizard(filtered[idx]):
                        clips = self.client.get_clips()
                continue

            if cmd.lower().startswith("k") and len(cmd) > 1 and cmd[1:].isdigit():
                idx = int(cmd[1:]) - 1
                if 0 <= idx < len(filtered):
                    clip_id = str(filtered[idx].get("id") or "")
                    try:
                        res = self.client.get_clip_kit(clip_id)
                        if res.get("ok"):
                            kit_path = _save_and_render_creator_kit(self.console, clip_id, res)
                            self.status_message = f"📦 Creator Kit saved → {kit_path}"
                            self.status_color = "bold green"
                        else:
                            self.console.print(Text(self._format_api_error(res, "Creator Kit error"), style="bold red"))
                    except Exception as exc:
                        self.console.print(Text(f"❌ Creator Kit error: {exc}", style="bold red"))
                    self.console.input("Press [Enter] to continue...")
                continue

            star_match = re.match(r"^star(\d+)(?:\s+(\S+))?$", cmd.lower())
            if star_match:
                idx = int(star_match.group(1)) - 1
                if 0 <= idx < len(filtered):
                    clip_id = str(filtered[idx].get("id") or "")
                    raw_val = star_match.group(2)
                    if raw_val is None:
                        raw_val = self.console.input(f"Enter star rating for #{idx + 1} [1-5]: ").strip()
                    try:
                        rating = int(raw_val)
                    except ValueError:
                        rating = 0
                    if not (1 <= rating <= 5):
                        self.console.print("[yellow]Rating must be an integer between 1 and 5.[/yellow]")
                        self.console.input("Press [Enter] to continue...")
                        continue
                    try:
                        res = self.client.rate_clip(clip_id, rating)
                        if res.get("ok"):
                            filtered[idx]["rating"] = rating
                            self.status_message = f"{'★' * rating} Rated '{filtered[idx].get('title', 'clip')}' {rating}/5"
                            self.status_color = "bold yellow"
                        else:
                            self.console.print(Text(self._format_api_error(res, "Rating error"), style="bold red"))
                            self.console.input("Press [Enter] to continue...")
                    except Exception as exc:
                        self.console.print(Text(f"❌ Rating error: {exc}", style="bold red"))
                        self.console.input("Press [Enter] to continue...")
                continue

            if cmd.lower().startswith("u") and len(cmd) > 1 and cmd[1:].isdigit():
                idx = int(cmd[1:]) - 1
                if 0 <= idx < len(filtered):
                    self._queue_clip_upload_wizard(filtered[idx])
                continue

            if cmd.lower() == "csv":
                out_csv = "clipper_clips_export.csv"
                try:
                    csv_text = self.client.export_clips_csv()
                    pathlib.Path(out_csv).write_text(csv_text, encoding="utf-8")
                    non_empty = [ln for ln in csv_text.splitlines() if ln.strip()]
                    rows = max(0, len(non_empty) - 1)
                    self.status_message = f"📤 Exported {rows} clip(s) → {out_csv}"
                    self.status_color = "bold green"
                    self.console.print(f"[bold green]✅ Exported {rows} clip(s) → ./{out_csv}[/bold green]")
                except Exception as exc:
                    self.console.print(Text(f"❌ CSV export failed: {exc}", style="bold red"))
                self.console.input("Press [Enter] to continue...")
                continue

            if cmd.lower() == "bmeta" or cmd.lower().startswith("bmeta "):
                tokens_part = cmd[5:].strip()
                if self._batch_metadata_gallery(tokens_part, filtered):
                    clips = self.client.get_clips()
                continue

            if cmd.lower() == "fav":
                fav_only = not fav_only
                continue

            # Toggle favourite: s[N] or *[N]
            if ((cmd.lower().startswith("s") and len(cmd) > 1 and cmd[1:].isdigit()) or
                    (cmd.startswith("*") and len(cmd) > 1 and cmd[1:].isdigit())):
                idx = int(cmd[1:]) - 1
                if 0 <= idx < len(filtered):
                    clip_id = filtered[idx].get("id", "")
                    try:
                        res = self.client.toggle_favourite(clip_id)
                        if res.get("ok"):
                            is_fav = bool(res.get("isFavourite"))
                            filtered[idx]["is_favourite"] = 1 if is_fav else 0
                            self.status_message = f"{'⭐ Starred' if is_fav else 'Unstarred'}: {filtered[idx].get('title', 'clip')}"
                            self.status_color = "yellow"
                        else:
                            self.console.print(Text(self._format_api_error(res, "Favourite error"), style="bold red"))
                            self.console.input("Press [Enter] to continue...")
                    except Exception as exc:
                        self.console.print(Text(f"❌ Error: {exc}", style="bold red"))
                        self.console.input("Press [Enter] to continue...")
                continue

            if cmd.lower().startswith("t") and len(cmd) > 1 and cmd[1:].isdigit():
                idx = int(cmd[1:]) - 1
                if 0 <= idx < len(filtered):
                    clip_id = filtered[idx].get("id", "")
                    cur_tags = str(filtered[idx].get("tags") or "")
                    self.console.print(f"\nCurrent tags: [cyan]{cur_tags or '(none)'}[/cyan]")
                    raw_tags = self.console.input("Enter comma-separated tags (a-z0-9-, max 10): ").strip()
                    clean_tags = [
                        re.sub(r"[^a-z0-9-]", "", t.strip().lower())
                        for t in raw_tags.split(",")
                    ]
                    tags_list = [t[:32] for t in clean_tags if t][:10]
                    try:
                        res = self.client.update_tags(clip_id, tags_list)
                        if res.get("ok"):
                            saved = res.get("tags", tags_list)
                            filtered[idx]["tags"] = ",".join(saved)
                            self.status_message = f"🏷️ Updated tags for {filtered[idx].get('title', 'clip')}"
                            self.status_color = "green"
                        else:
                            self.console.print(Text(self._format_api_error(res, "Tags error"), style="bold red"))
                            self.console.input("Press [Enter] to continue...")
                    except Exception as exc:
                        self.console.print(Text(f"❌ Tags error: {exc}", style="bold red"))
                        self.console.input("Press [Enter] to continue...")
                continue

            if cmd.lower().startswith("n") and len(cmd) > 1 and cmd[1:].isdigit():
                idx = int(cmd[1:]) - 1
                if 0 <= idx < len(filtered):
                    clip_id = filtered[idx].get("id", "")
                    cur_notes = str(filtered[idx].get("notes") or "")
                    self.console.print(f"\nCurrent notes: [cyan]{cur_notes or '(none)'}[/cyan]")
                    new_notes = self.console.input("Enter clip notes (max 2000 chars): ").strip()
                    try:
                        res = self.client.update_notes(clip_id, new_notes)
                        if res.get("ok"):
                            filtered[idx]["notes"] = new_notes
                            self.status_message = f"📝 Updated notes for {filtered[idx].get('title', 'clip')}"
                            self.status_color = "green"
                        else:
                            self.console.print(Text(self._format_api_error(res, "Notes error"), style="bold red"))
                            self.console.input("Press [Enter] to continue...")
                    except Exception as exc:
                        self.console.print(Text(f"❌ Notes error: {exc}", style="bold red"))
                        self.console.input("Press [Enter] to continue...")
                continue

            if cmd.lower().startswith("s"):
                search_query = cmd[1:].strip().lower()
                continue

            if cmd.startswith("/"):
                search_query = cmd[1:].strip().lower()
                continue

            if cmd.lower().startswith("f"):
                val = cmd[1:].strip()
                try:
                    min_score = float(val) if val else 0.0
                except ValueError:
                    min_score = 0.0
                continue

            if cmd.isdigit():
                idx = int(cmd) - 1
                if 0 <= idx < len(filtered):
                    fpath = filtered[idx].get("file_path", "")
                    ok, msg = open_media_file(fpath)
                    self.status_message = msg
                    self.status_color = "green" if ok else "red"
                    return
                continue

            if cmd.lower().startswith("e") and cmd[1:].isdigit():
                idx = int(cmd[1:]) - 1
                if 0 <= idx < len(filtered):
                    fpath = filtered[idx].get("file_path", "")
                    ok, msg = reveal_media_file(fpath)
                    self.status_message = msg
                    self.status_color = "green" if ok else "red"
                    return
                continue

            if cmd.lower().startswith("m") and cmd[1:].isdigit():
                idx = int(cmd[1:]) - 1
                if 0 <= idx < len(filtered):
                    clip_id = filtered[idx].get("id", "")
                    self.console.print("\n[dim]Generating viral social title & hashtags...[/dim]")
                    try:
                        res = self.client.generate_clip_metadata(clip_id)
                        if res.get("ok"):
                            meta = res.get("metadata", res)
                            s_title = meta.get("socialTitle") or res.get("socialTitle", "")
                            s_desc = meta.get("socialDescription") or res.get("socialDescription", "")
                            tags = meta.get("hashtags") or res.get("hashtags") or []
                            tag_str = " ".join(tags) if isinstance(tags, list) else str(tags)
                            panel_body = Text.assemble(
                                ("Title: ", "bold cyan"), (f"{s_title}\n", "bold white"),
                                ("Desc:  ", "bold cyan"), (f"{s_desc}\n", "white"),
                                ("Tags:  ", "bold cyan"), (tag_str, "green"),
                            )
                            self.console.print(Panel(panel_body, title="✨ Social Metadata", box=box.ROUNDED, style="magenta"))
                            self.status_message = f"✅ Generated social metadata for {filtered[idx].get('title', 'clip')}"
                            self.status_color = "green"
                        else:
                            msg = self._format_api_error(res, "Metadata error")
                            self.console.print(Text(msg, style="bold yellow" if res.get("upgrade_required") else "bold red"))
                    except Exception as exc:
                        self.console.print(Text(f"❌ Metadata error: {exc}", style="bold red"))
                    self.console.input("\nPress [Enter] to continue...")
                continue

            if cmd.lower().startswith("c "):
                raw_nums = [x.strip() for x in cmd[2:].replace(",", " ").split() if x.strip()]
                selected_ids: List[str] = []
                for token in raw_nums:
                    if token.isdigit():
                        idx = int(token) - 1
                        if 0 <= idx < len(filtered) and filtered[idx].get("id"):
                            selected_ids.append(filtered[idx]["id"])
                if len(selected_ids) < 2:
                    self.console.print("[yellow]Select at least 2 valid clip numbers (e.g. c 1,2,3).[/yellow]")
                    self.console.input("Press [Enter] to continue...")
                    continue

                montage_title = self.console.input("Montage title (default='montage_reel'): ").strip() or "montage_reel"
                norm_in = self.console.input("Apply -14 LUFS audio normalize? [y/N]: ").strip().lower()
                music_track = ""
                tracks = self.client.get_music_tracks()
                if tracks:
                    self.console.print("\n[bold]Optional Background Music (06_music/):[/bold]")
                    self.console.print("   [0] None")
                    for tidx, tr in enumerate(tracks[:10], 1):
                        self.console.print(f"   [{tidx}] 🎵 {tr.get('name', tr.get('title', 'track'))}")
                    msel = self.console.input(f"Choose music track [0-{len(tracks[:10])}, default=0]: ").strip()
                    if msel.isdigit() and 1 <= int(msel) <= len(tracks[:10]):
                        music_track = tracks[int(msel) - 1].get("path", "")

                self.console.print(f"[bold yellow]🎬 Compiling {len(selected_ids)} clips into montage...[/bold yellow]")
                try:
                    res = self.client.compile_montage(
                        clip_ids=selected_ids,
                        title=montage_title,
                        music_path=music_track,
                        audio_normalize=norm_in in ("y", "yes"),
                    )
                    if res.get("ok"):
                        clip_obj = res.get("clip") or res
                        fp = clip_obj.get("filePath") or res.get("filePath", "")
                        self.status_message = f"✅ Montage compiled: {os.path.basename(fp)}"
                        self.status_color = "bold green"
                        self.console.print(f"[bold green]✅ Montage saved:[/bold green] {fp}")
                        clips = self.client.get_clips()
                    else:
                        msg = self._format_api_error(res, "Montage compile failed")
                        self.console.print(Text(msg, style="bold yellow" if res.get("upgrade_required") else "bold red"))
                except Exception as exc:
                    self.console.print(Text(f"❌ Montage error: {exc}", style="bold red"))
                self.console.input("Press [Enter] to continue...")

    def show_diagnostics(self) -> None:
        """[D] Displays system dependencies, storage, counts, and security posture."""
        self.console.clear()
        self.console.print("\n[bold green]🩺 Clipper Studio System Diagnostics[/bold green]\n")
        try:
            res = self.client.get_diagnostics()
            if res.get("ok"):
                _render_diagnostics(self.console, res)
                self.status_message = "✅ System diagnostics loaded."
                self.status_color = "bold green"
            else:
                msg = self._format_api_error(res, "Diagnostics error")
                self.console.print(Text(msg, style="bold red"))
        except Exception as exc:
            msg = f"❌ Diagnostics failed: {exc}"
            self.status_message = msg
            self.status_color = "bold red"
            self.console.print(Text(msg, style="bold red"))
        self.console.input("\nPress [Enter] to return...")

    def prompt_presets_manager(self) -> None:
        """[P] Lists built-in & custom presets, applies presets to TUI defaults, creates or deletes custom presets."""
        while True:
            self.console.clear()
            self.console.print("\n[bold cyan]⚡ Clipper Studio Presets Manager[/bold cyan]")
            self.console.print(
                f"[dim]Active TUI Defaults: layout={LAYOUT_OPTIONS[self.layout_idx][0]} | "
                f"facecam={FACECAM_OPTIONS[self.facecam_idx][0]} | "
                f"captions={CAPTION_OPTIONS[self.caption_idx][0]}[/dim]\n"
            )
            try:
                presets = self.client.list_presets(raise_on_error=True)
            except Exception as exc:
                msg = f"❌ Failed to load presets: {exc}"
                self.status_message = msg
                self.status_color = "bold red"
                self.console.print(Text(msg, style="bold red"))
                self.console.input("\nPress [Enter] to return...")
                return

            if presets:
                _render_presets_table(self.console, presets, numbered=True)
            else:
                self.console.print("[dim]No presets saved yet.[/dim]")

            self.console.print("\n[bold cyan]Preset Actions:[/bold cyan]")
            if presets:
                self.console.print(f"  [bold]1-{len(presets)}[/bold]    Apply preset to active TUI defaults")
                self.console.print("  [bold]d<N>[/bold]   Delete custom preset #N (e.g. d4)")
            self.console.print("  [bold]n[/bold]      Create new custom preset from current TUI settings")
            self.console.print("  [bold][Enter][/bold] Return to dashboard\n")

            cmd = self.console.input("Select action: ").strip()
            if not cmd or cmd.lower() == "q":
                return

            if cmd.isdigit():
                idx = int(cmd) - 1
                if 0 <= idx < len(presets):
                    chosen = presets[idx]
                    applied = self._apply_preset_to_tui(chosen)
                    pname = chosen.get("name", "Preset")
                    self.status_message = (
                        f"✅ Applied preset '{pname}' "
                        f"(layout={applied['layout']}, facecam={applied['facecam']}, captions={applied['caption_style']})"
                    )
                    self.status_color = "bold green"
                    self.console.print(f"\n[bold green]{self.status_message}[/bold green]")
                    self.console.input("Press [Enter] to continue...")
                continue

            if cmd.lower() == "n":
                cur_layout = LAYOUT_OPTIONS[self.layout_idx][0]
                cur_facecam = FACECAM_OPTIONS[self.facecam_idx][0]
                cur_captions = CAPTION_OPTIONS[self.caption_idx][0]
                self.console.print(
                    f"\n[bold]Create Custom Preset[/bold] "
                    f"([cyan]layout={cur_layout}, facecam={cur_facecam}, captions={cur_captions}[/cyan])"
                )
                name = self.console.input("Preset name (1-64 chars, blank=cancel): ").strip()
                if not name:
                    continue
                desc = self.console.input("Description (optional): ").strip()
                norm_in = self.console.input("Enable -14 LUFS audio normalize? [Y/n]: ").strip().lower()
                sil_in = self.console.input("Enable dead-air silence cut? [y/N]: ").strip().lower()
                hook = self.console.input("Hook title overlay (optional, max 80 chars): ").strip()
                wm = self.console.input("Watermark text (optional, max 60 chars): ").strip()

                music_track = ""
                music_vol = 0.15
                tracks = self.client.get_music_tracks()
                if tracks:
                    self.console.print("\n[bold]Optional Music Track (06_music/):[/bold]")
                    self.console.print("   [0] None")
                    for tidx, tr in enumerate(tracks[:10], 1):
                        self.console.print(f"   [{tidx}] 🎵 {tr.get('name', tr.get('title', 'track'))}")
                    msel = self.console.input(f"Choose track [0-{len(tracks[:10])}, default=0]: ").strip()
                    if msel.isdigit() and 1 <= int(msel) <= len(tracks[:10]):
                        music_track = tracks[int(msel) - 1].get("name", "") or tracks[int(msel) - 1].get("path", "")
                        vraw = self.console.input("Music volume (0.0-1.0, default=0.15): ").strip()
                        if vraw:
                            try:
                                music_vol = max(0.0, min(1.0, float(vraw)))
                            except ValueError:
                                pass

                try:
                    res = self.client.create_preset(
                        name=name[:64],
                        description=desc[:300],
                        layout=cur_layout,
                        facecam_position=cur_facecam,
                        caption_style=cur_captions,
                        silence_cut=sil_in in ("y", "yes"),
                        audio_normalize=norm_in not in ("n", "no"),
                        music_track=music_track,
                        music_volume=music_vol,
                        hook_title=hook[:80],
                        watermark_text=wm[:60],
                    )
                    if res.get("ok"):
                        self.status_message = f"✅ Saved preset '{name}'"
                        self.status_color = "bold green"
                        self.console.print(f"\n[bold green]✅ Created preset '{name}'[/bold green]")
                    else:
                        self.console.print(Text(self._format_api_error(res, "Create preset failed"), style="bold red"))
                except Exception as exc:
                    self.console.print(Text(f"❌ Create preset error: {exc}", style="bold red"))
                self.console.input("Press [Enter] to continue...")
                continue

            if cmd.lower().startswith("d") and len(cmd) > 1 and cmd[1:].isdigit():
                idx = int(cmd[1:]) - 1
                if 0 <= idx < len(presets):
                    chosen = presets[idx]
                    if chosen.get("is_builtin") in (1, True):
                        self.console.print("\n[yellow]Built-in presets cannot be deleted.[/yellow]")
                        self.console.input("Press [Enter] to continue...")
                        continue
                    confirm = self.console.input(f"Delete custom preset '{chosen.get('name', '')}'? [y/N]: ").strip().lower()
                    if confirm not in ("y", "yes"):
                        continue
                    try:
                        res = self.client.delete_preset(str(chosen.get("id", "")))
                        if res.get("ok"):
                            self.status_message = f"🗑️ Deleted preset '{chosen.get('name', '')}'"
                            self.status_color = "yellow"
                            self.console.print(f"[bold green]✅ {self.status_message}[/bold green]")
                        else:
                            self.console.print(Text(self._format_api_error(res, "Delete preset failed"), style="bold red"))
                    except Exception as exc:
                        self.console.print(Text(f"❌ Delete preset error: {exc}", style="bold red"))
                    self.console.input("Press [Enter] to continue...")

    def handle_keypress(self, key: str, status: Dict[str, Any]) -> None:
        k = key.lower()
        if k in ("q", "\x03"):  # q or Ctrl-C
            self.running = False
        elif k == "s":
            self.prompt_start()
        elif k == "m":
            self.prompt_after_live_clip()
        elif k == "k":
            self.prompt_license_manager()
        elif k == "p":
            self.prompt_presets_manager()
        elif k == "d":
            self.show_diagnostics()
        elif k == "x":
            try:
                res = self.client.stop_session()
                if res.get("ok"):
                    self.status_message = res.get("message", "Monitoring stopped.")
                    self.status_color = "yellow"
                else:
                    self._format_api_error(res, "Stop error")
            except Exception as exc:
                self.status_message = f"Error stopping: {exc}"
                self.status_color = "red"
        elif k in ("c", " "):
            if not status.get("active"):
                self.status_message = "Cannot clip: no stream is currently being monitored! Press [S] first."
                self.status_color = "bold red"
            else:
                self.status_message = "⚡ Extracting instant clip (last 20s)..."
                self.status_color = "bold yellow"
                try:
                    res = self.client.clip_now(20)
                    if res.get("ok"):
                        clip_path = res.get("clip", {}).get("filePath", "")
                        self._refresh_billing_cache(force=True)
                        self.status_message = f"✅ Clip saved: {os.path.basename(clip_path)}"
                        self.status_color = "bold green"
                    else:
                        self._format_api_error(res, "Clip failed")
                except Exception as exc:
                    self.status_message = f"❌ Clip error: {exc}"
                    self.status_color = "bold red"
        elif k == "u":
            # Upgrade plan — open upgrade link or fallback to checkout / local /upgrade
            if not self.billing_cache:
                self._refresh_billing_cache(force=True)
            ent = self.billing_cache.get("entitlement", {})
            current_plan = str(ent.get("plan", {}).get("id", "free")).lower()
            if current_plan == "ultra":
                webbrowser.open(f"{self.client.base_url}/upgrade")
                self.status_message = "🚀 You are already on ULTRA! Opened /upgrade in browser."
                self.status_color = "bold cyan"
                return

            target_plan = "pro" if current_plan == "free" else "ultra"
            self.status_message = f"🔗 Getting upgrade link for {target_plan.upper()}..."
            self.status_color = "cyan"
            try:
                res = self.client.get_upgrade_link(target_plan)
                if res.get("ok") and res.get("url"):
                    webbrowser.open(res["url"])
                    self.status_message = f"💎 Opened {target_plan.upper()} upgrade link in browser!"
                    self.status_color = "bold cyan"
                else:
                    chk = self.client.create_checkout(target_plan)
                    if chk.get("ok") and chk.get("checkoutUrl"):
                        webbrowser.open(chk["checkoutUrl"])
                        self.status_message = f"💳 Opened {target_plan.upper()} Stripe Checkout in browser!"
                        self.status_color = "bold cyan"
                    else:
                        webbrowser.open(f"{self.client.base_url}/upgrade")
                        self.status_message = f"🌐 Opened /upgrade page in browser for {target_plan.upper()}."
                        self.status_color = "yellow"
            except Exception:
                webbrowser.open(f"{self.client.base_url}/upgrade")
                self.status_message = f"🌐 Opened /upgrade page in browser for {target_plan.upper()}."
                self.status_color = "yellow"
        elif k == "l":
            self.layout_idx = (self.layout_idx + 1) % len(LAYOUT_OPTIONS)
            selected = LAYOUT_OPTIONS[self.layout_idx]
            self.status_message = f"Layout changed to: {selected[1]}"
            self.status_color = "cyan"
        elif k == "f":
            self.facecam_idx = (self.facecam_idx + 1) % len(FACECAM_OPTIONS)
            selected = FACECAM_OPTIONS[self.facecam_idx]
            self.status_message = f"Facecam mode changed to: {selected[1]}"
            self.status_color = "green"
        elif k == "g":
            self.show_gallery()

    def _poll_nonblocking_key(self) -> Optional[str]:
        """Reads a single non-blocking hotkey across Windows and POSIX TTYs, filtering arrow/escape sequences."""
        if HAS_MSVCRT:
            if not msvcrt.kbhit():
                return None
            ch = msvcrt.getch()
            if ch in (b"\x00", b"\xe0"):
                # Consume second byte of extended/arrow/Delete key so it never triggers hotkeys
                msvcrt.getch()
                return None
            return ch.decode("utf-8", errors="ignore")

        if HAS_POSIX_TTY and sys.stdin.isatty():
            ready, _, _ = select.select([sys.stdin], [], [], 0)
            if not ready:
                return None
            ch = sys.stdin.read(1)
            if ch == "\x1b":
                # Drain trailing ANSI arrow/function key bytes cleanly
                while select.select([sys.stdin], [], [], 0.01)[0]:
                    sys.stdin.read(1)
                return None
            return ch

        return None

    def run(self) -> None:
        """Main TUI loop with 4Hz refresh rate and safe terminal restoration."""
        self.console.clear()
        posix_fd: Optional[int] = None
        posix_orig_attrs: Any = None

        if not HAS_MSVCRT and HAS_POSIX_TTY and sys.stdin.isatty():
            try:
                posix_fd = sys.stdin.fileno()
                posix_orig_attrs = termios.tcgetattr(posix_fd)
                tty.setcbreak(posix_fd)
            except Exception:
                posix_fd = None
                posix_orig_attrs = None

        try:
            with Live(console=self.console, screen=True, refresh_per_second=4) as live:
                while self.running:
                    self.poll_tick += 1
                    status = self.client.get_status()
                    self._refresh_billing_cache(force=False)

                    if status.get("active"):
                        if self.poll_tick % 8 == 0 or self.last_facecam is None:
                            fc = self.client.get_facecam()
                            if fc:
                                self.last_facecam = fc
                    else:
                        self.last_facecam = None

                    live.update(self.render(status))

                    key_str = self._poll_nonblocking_key()
                    if key_str:
                        live.stop()
                        if posix_fd is not None and posix_orig_attrs is not None:
                            termios.tcsetattr(posix_fd, termios.TCSADRAIN, posix_orig_attrs)
                        try:
                            self.handle_keypress(key_str, status)
                        finally:
                            if self.running and posix_fd is not None:
                                tty.setcbreak(posix_fd)
                            live.start()

                    time.sleep(0.25)
        except KeyboardInterrupt:
            self.running = False
        finally:
            if posix_fd is not None and posix_orig_attrs is not None:
                try:
                    termios.tcsetattr(posix_fd, termios.TCSADRAIN, posix_orig_attrs)
                except Exception:
                    pass


def _exit_if_failed(console: Console, res: Dict[str, Any], action: str) -> None:
    if res.get("ok"):
        return
    if res.get("upgrade_required"):
        plan = str(res.get("required_plan", "pro")).upper()
        console.print(
            Text(
                f"[🔒 LOCKED] {res.get('error', 'Plan upgrade required.')} "
                f"(Required: {plan}) — Activate key with --activate-key or press [K] in TUI.",
                style="bold yellow",
            )
        )
    else:
        console.print(Text(f"❌ {action} failed: {res.get('error', 'Unknown error')}", style="bold red"))
    sys.exit(1)


def _run_tool_updater(console: Console, auto_yes: bool = False) -> None:
    """Runs update.ps1 on Windows or update.sh on POSIX after confirmation or --yes."""
    repo_dir = os.path.dirname(os.path.abspath(__file__))
    if sys.platform == "win32":
        script_path = os.path.join(repo_dir, "update.ps1")
        if not os.path.exists(script_path):
            console.print(Text(f"❌ Updater script not found: {script_path}", style="bold red"))
            sys.exit(1)
        cmd = ["powershell", "-ExecutionPolicy", "Bypass", "-File", script_path]
        if auto_yes:
            cmd.append("-Yes")
    else:
        script_path = os.path.join(repo_dir, "update.sh")
        if not os.path.exists(script_path):
            console.print(Text(f"❌ Updater script not found: {script_path}", style="bold red"))
            sys.exit(1)
        cmd = ["bash", script_path]
        if auto_yes:
            cmd.append("--yes")

    if not auto_yes:
        ans = console.input(
            f"Run [bold cyan]{os.path.basename(script_path)}[/bold cyan] to back up & update Clipper Studio? [y/N]: "
        ).strip().lower()
        if ans not in ("y", "yes"):
            console.print("[yellow]Update cancelled.[/yellow]")
            return

    proc = subprocess.run(cmd, cwd=repo_dir, check=False)
    if proc.returncode != 0:
        sys.exit(proc.returncode)


def run_cli_mode(args: argparse.Namespace, client: ClipperClient) -> None:
    """Handles direct non-interactive CLI flags and exits non-zero on API/connection/402 errors."""
    console = Console()
    # Resolve --preset into args fields before dispatch
    _preset_data: Dict[str, Any] = {}
    try:
        if getattr(args, "preset", None):
            presets = client.list_presets()
            matched = next(
                (p for p in presets if p.get("name", "").lower() == str(args.preset).lower() or str(p.get("id", "")) == str(args.preset)),
                None,
            )
            if matched:
                settings = matched.get("settings")
                _preset_data = settings if isinstance(settings, dict) and settings else matched
                console.print(f"[bold cyan]📋 Applying preset: {matched.get('name')}[/bold cyan]")
            else:
                console.print(f"[bold yellow]⚠ Preset '{args.preset}' not found — ignoring.[/bold yellow]")
    except Exception:
        pass  # preset lookup failures are non-fatal

    def _ps(key: str, default: Any = None, *alt_keys: str) -> Any:
        """Return preset value if present across snake_case/camelCase keys, else default."""
        for candidate in (key, *alt_keys):
            if candidate in _preset_data and _preset_data[candidate] is not None:
                return _preset_data[candidate]
        return default

    has_preset = bool(_preset_data)
    user_explicit = {
        "captions": args.captions is not None,
        "normalize": args.normalize is not None,
        "silence_cut": args.silence_cut is not None,
        "music": args.music is not None,
        "music_volume": args.music_volume is not None,
        "hook": args.hook is not None,
        "watermark": args.watermark is not None,
    }
    args.layout = args.layout if args.layout is not None else str(_ps("layout", "split") or "split")
    args.facecam = args.facecam if args.facecam is not None else str(_ps("facecam_position", "auto", "facecamPosition") or "auto")
    args.captions = args.captions if args.captions is not None else str(_ps("caption_style", "none", "captionStyle") or "none")
    args.normalize = bool(args.normalize) if args.normalize is not None else bool(_ps("audio_normalize", False, "audioNormalize"))
    args.silence_cut = bool(args.silence_cut) if args.silence_cut is not None else bool(_ps("silence_cut", False, "silenceCut"))
    args.music = args.music if args.music is not None else str(_ps("music_track", "", "musicTrack") or "")
    raw_music_vol = args.music_volume if args.music_volume is not None else _ps("music_volume", 0.18, "musicVolume")
    args.music_volume = float(raw_music_vol if raw_music_vol is not None else 0.18)
    args.hook = args.hook if args.hook is not None else str(_ps("hook_title", "", "hookTitle") or "")
    args.watermark = args.watermark if args.watermark is not None else str(_ps("watermark_text", "", "watermarkText") or "")

    try:
        if args.update_tool:
            _run_tool_updater(console, auto_yes=bool(args.yes))
            return

        if args.check_update:
            res = client.check_system_version(check_remote=True)
            _exit_if_failed(console, res, "Check update")
            ver = res.get("version") or res.get("packageVersion") or "0.0.1"
            commit = res.get("shortCommit") or res.get("commit") or res.get("sha") or "unknown"
            branch = res.get("branch") or res.get("gitBranch") or "main"
            behind = int(res.get("behind") or res.get("commitsBehind") or 0)
            update_avail = bool(res.get("updateAvailable", behind > 0))
            console.print(f"[bold cyan]Version:[/bold cyan] v{ver} ({commit}) on branch [bold]{branch}[/bold]")
            if update_avail:
                console.print(f"[bold yellow]⬆️ Update available ({behind} commit(s) behind origin)![/bold yellow]")
                cmd_hint = ".\\update.ps1" if sys.platform == "win32" else "./update.sh"
                console.print(f"Run [bold green]python clipper_tui.py --update-tool[/bold green] or [bold]{cmd_hint}[/bold] to update.")
            else:
                console.print("[bold green]✅ Clipper Studio is up to date.[/bold green]")
            return

        if args.analytics:
            res = client.get_analytics()
            _exit_if_failed(console, res, "Analytics summary")
            total_clips = int(res.get("totalClips", 0))
            clips_month = int(res.get("clipsThisMonth", 0))
            total_dur = int(round(float(res.get("totalDurationSec", 0))))
            storage_bytes = float(res.get("storageUsedBytes", 0))
            avg_vir = res.get("avgViralityScore", 0)
            storage_str = f"{storage_bytes / 1e9:.2f} GB" if storage_bytes >= 1e9 else f"{storage_bytes / 1e6:.1f} MB"
            summary_txt = Text.assemble(
                ("Total Clips:      ", "bold"), (f"{total_clips}\n", "cyan"),
                ("Clips This Month: ", "bold"), (f"{clips_month}\n", "green"),
                ("Total Duration:   ", "bold"), (f"{total_dur // 60}m {total_dur % 60}s\n", "blue"),
                ("Storage Used:     ", "bold"), (f"{storage_str}\n", "yellow"),
                ("Avg Virality:     ", "bold"), (f"{avg_vir}/100", "magenta"),
            )
            console.print(Panel(summary_txt, title="📊 Clipper Studio Analytics", box=box.ROUNDED, style="cyan"))
            platforms = res.get("topPlatforms") or []
            if platforms:
                pt = Table(title="Top Platforms", box=box.ROUNDED)
                pt.add_column("Platform", style="bold white")
                pt.add_column("Clips", justify="right", style="cyan")
                for item in platforms:
                    pt.add_row(str(item.get("platform", "local")).upper(), str(item.get("count", 0)))
                console.print(pt)
            return

        if args.activate_key:
            res = client.activate_license(args.activate_key)
            _exit_if_failed(console, res, "License activation")
            plan = res.get("entitlement", {}).get("plan", {})
            console.print(
                f"[bold green]✅ Activated plan: {plan.get('name', 'Paid')} ({str(plan.get('id', '')).upper()})[/bold green]"
            )
            has_other_action = any([
                args.plan_status, args.status, args.start, args.stop,
                args.clip is not None, args.clips, args.list_streams,
                args.manual_clip, args.audio_peaks, args.auto_clip_top is not None,
                bool(args.montage), args.analytics, args.check_update, args.update_tool,
                args.doctor, bool(args.reexport), bool(args.export_csv),
                bool(args.batch_metadata), bool(args.kit),
                args.presets, args.collections, args.top_rated, args.queue_list, bool(args.share),
            ])
            if not has_other_action:
                return

        if args.plan_status:
            data = client.get_billing_status(raise_on_error=True)
            _exit_if_failed(console, data, "Plan status")
            ent = data.get("entitlement", {})
            plan = ent.get("plan", {})
            usage = ent.get("usage", {})
            lic = ent.get("license", {})
            used = usage.get("usedToday", 0)
            limit = usage.get("dailyLimit", 3)
            unlimited = bool(usage.get("unlimited", False)) or limit < 0
            quota = f"{used} today (Unlimited)" if unlimited else f"{used} / {limit} today"

            console.print(f"[bold cyan]Plan:[/bold cyan] {plan.get('name', 'Free Starter')} ({str(plan.get('id', 'free')).upper()})")
            console.print(f"[bold cyan]Max Resolution:[/bold cyan] {plan.get('max_resolution', 720)}p")
            console.print(f"[bold cyan]Daily Usage:[/bold cyan] {quota}")
            console.print(f"[bold cyan]License:[/bold cyan] {lic.get('maskedKey') or 'None'} ({lic.get('provider', 'free')})")
            return

        if args.status:
            s = client.get_status()
            if not s.get("connected", True):
                console.print(Text(f"❌ Could not connect to Clipper service at {client.base_url}", style="bold red"))
                sys.exit(1)
            if not s.get("active"):
                console.print("[bold yellow]Status: IDLE[/bold yellow] (No stream monitored)")
            else:
                console.print(f"[bold red]Status: MONITORING[/bold red] on {s.get('platform')}: {s.get('channelOrUrl')}")
                console.print(f"Layout: {s.get('layout')} | Facecam: {s.get('facecamPosition')} | Captions: {s.get('captionStyle', 'none')}")
                console.print(f"Velocity: {s.get('currentVelocity', 0):.1f} msg/s (Baseline: {s.get('baselineVelocity', 0):.1f} msg/s)")
            return

        if args.start:
            if not args.channel:
                console.print("[bold red]Error: --channel required when using --start[/bold red]")
                sys.exit(1)
            triggers = [k.strip() for k in (args.triggers or "").split(",") if k.strip()] or None
            res = client.start_session(
                platform=args.platform,
                channel=args.channel,
                layout=args.layout,
                facecam=args.facecam,
                caption_style=args.captions,
                watermark_text=args.watermark or "",
                hook_title=args.hook or "",
                audio_normalize=bool(args.normalize),
                trigger_keywords=triggers,
                spike_multiplier=float(args.multiplier),
                min_spike=float(args.min_threshold),
                save_recording=bool(args.save_recording),
            )
            _exit_if_failed(console, res, "Start monitoring")
            console.print(f"[bold green]✅ Started monitoring {args.platform}: {args.channel}[/bold green]")
            return

        if args.list_streams:
            if not args.channel:
                console.print("[bold red]Error: --channel required when using --list-streams[/bold red]")
                sys.exit(1)
            streams = client.get_past_streams(args.platform, args.channel)
            t = Table(title=f"Past Streams ({args.platform}: {args.channel})", box=box.ROUNDED)
            t.add_column("Title", style="bold white")
            t.add_column("Duration", style="green")
            t.add_column("URL", style="cyan")
            for st in streams:
                t.add_row(st.get("title", ""), f"{st.get('durationSec', 0)}s", st.get("url", ""))
            console.print(t)
            return

        if args.audio_peaks:
            if not args.source:
                console.print("[bold red]Error: --source file path or VOD URL required for --audio-peaks[/bold red]")
                sys.exit(1)
            res = client.scan_audio_peaks(args.source)
            _exit_if_failed(console, res, "Audio peak scan")
            peaks = res.get("peaks", [])
            if not peaks:
                console.print("[yellow]No loud hype audio peaks detected above baseline.[/yellow]")
                return
            t = Table(title=f"⚡ Audio Peaks (Avg {res.get('avgDb', -40)} dB)", box=box.ROUNDED)
            t.add_column("#", width=4, style="cyan")
            t.add_column("Window", style="green")
            t.add_column("Delta", style="yellow")
            t.add_column("🔥 Score", style="magenta")
            t.add_column("Reason", style="dim")
            for i, pk in enumerate(peaks, 1):
                t.add_row(
                    str(i),
                    f"{pk.get('startSec', 0):.1f}s → {pk.get('endSec', 25):.1f}s",
                    f"+{pk.get('deltaDb', 0):.1f} dB",
                    f"🔥 {pk.get('viralityScore', 0)}",
                    str(pk.get("reason", "")),
                )
            console.print(t)
            return

        if args.auto_clip_top is not None:
            if not args.source:
                console.print("[bold red]Error: --source file path or VOD URL required for --auto-clip-top[/bold red]")
                sys.exit(1)
            top_n = max(1, int(args.auto_clip_top))
            console.print(f"[bold yellow]🚀 Auto-clipping top {top_n} hype peaks from {args.source}...[/bold yellow]")
            res = client.auto_clip_batch(
                source=args.source,
                top_n=top_n,
                layout=args.layout,
                facecam=args.facecam,
                caption_style=args.captions,
                watermark_text=args.watermark or "",
                hook_title=args.hook or "",
                audio_normalize=bool(args.normalize),
                trim_silence=bool(args.silence_cut),
                music_path=args.music or "",
                music_volume=float(args.music_volume),
            )
            _exit_if_failed(console, res, "Batch auto-clip")
            clips = res.get("clips") or res.get("results") or []
            console.print(f"[bold green]✅ Rendered {len(clips)} clips:[/bold green]")
            for c in clips:
                fp = c.get("filePath") or c.get("file_path", "")
                sc = c.get("viralityScore") or c.get("virality_score", 0)
                console.print(f"  • {fp} (🔥 {sc}/100)")
            return

        if args.manual_clip:
            if not args.source:
                console.print("[bold red]Error: --source file path or VOD URL required for --manual-clip[/bold red]")
                sys.exit(1)
            start_s = float(args.start_sec or 0.0)
            end_s = float(args.end_sec or (start_s + 25.0))
            console.print(f"[bold yellow]Cutting manual clip {start_s}s → {end_s}s from {args.source}...[/bold yellow]")
            res = client.cut_manual_clip(
                source=args.source,
                start_sec=start_s,
                end_sec=end_s,
                layout=args.layout,
                facecam=args.facecam,
                title=args.title or "",
                caption_style=args.captions,
                watermark_text=args.watermark or "",
                hook_title=args.hook or "",
                audio_normalize=bool(args.normalize),
                trim_silence=bool(args.silence_cut),
                music_path=args.music or "",
                music_volume=float(args.music_volume),
            )
            _exit_if_failed(console, res, "Manual clip")
            console.print(f"[bold green]✅ Saved clip: {res.get('clip', {}).get('filePath')}[/bold green]")
            return

        if args.montage:
            clip_ids = [cid.strip() for cid in args.montage.replace(" ", ",").split(",") if cid.strip()]
            if len(clip_ids) < 2:
                console.print("[bold red]Error: --montage requires at least 2 comma-separated clip IDs[/bold red]")
                sys.exit(1)
            console.print(f"[bold yellow]🎞️ Compiling {len(clip_ids)} clips into montage...[/bold yellow]")
            res = client.compile_montage(
                clip_ids=clip_ids,
                title=args.title or "montage_reel",
                music_path=args.music or "",
                music_volume=float(args.music_volume),
                audio_normalize=bool(args.normalize),
            )
            _exit_if_failed(console, res, "Montage compilation")
            clip_obj = res.get("clip") or res
            fp = clip_obj.get("filePath") or res.get("filePath", "")
            console.print(f"[bold green]✅ Montage saved: {fp}[/bold green]")
            return

        if args.stop:
            res = client.stop_session()
            _exit_if_failed(console, res, "Stop session")
            console.print(f"[bold yellow]{res.get('message', 'Monitoring stopped.')}[/bold yellow]")
            return

        if args.clip is not None:
            dur = int(args.clip) if str(args.clip).isdigit() else 20
            console.print(f"[bold yellow]Triggering clip ({dur}s)...[/bold yellow]")
            res = client.clip_now(dur)
            _exit_if_failed(console, res, "Instant clip")
            fpath = res.get("clip", {}).get("filePath", "")
            console.print(f"[bold green]✅ Clip saved: {fpath}[/bold green]")
            return

        if args.clips:
            clips = client.get_clips(raise_on_error=True)
            if not clips:
                console.print("[dim]No clips in library.[/dim]")
                return
            t = Table(title="Rendered Clips", box=box.ROUNDED)
            t.add_column("Title", style="bold cyan")
            t.add_column("🔥 Score", style="magenta", justify="right")
            t.add_column("Duration", style="green", justify="right")
            t.add_column("Size", style="yellow", justify="right")
            t.add_column("File Path", style="dim")
            for c in clips:
                sc = float(c.get("virality_score") or 0)
                t.add_row(
                    c.get("title", ""),
                    f"🔥 {int(round(sc))}" if sc > 0 else "—",
                    f"{c.get('duration_sec', 20):.1f}s",
                    f"{c.get('file_size_bytes', 0)/(1024*1024):.1f} MB",
                    c.get("file_path", ""),
                )
            console.print(t)
            return

        # ── --doctor: system diagnostics ──────────────────────────────────────
        if args.doctor:
            res = client.get_diagnostics()
            _exit_if_failed(console, res, "System diagnostics")
            _render_diagnostics(console, res)
            return

        # ── --presets: list saved editing presets ─────────────────────────────
        if args.presets:
            presets = client.list_presets(raise_on_error=True)
            if not presets:
                console.print("[dim]No editing presets found.[/dim]")
                return
            _render_presets_table(console, presets, numbered=False)
            return

        # ── --collections: list clip collections ──────────────────────────────
        if args.collections:
            collections = client.list_collections(raise_on_error=True)
            if not collections:
                console.print("[dim]No clip collections created yet.[/dim]")
                return
            t = Table(title="📚 Clip Collections", box=box.ROUNDED)
            t.add_column("ID", style="dim", width=16)
            t.add_column("Name", style="bold white")
            t.add_column("Clips", justify="right", style="cyan", width=7)
            t.add_column("Color", style="magenta", width=9)
            t.add_column("Description", style="dim")
            for col in collections:
                t.add_row(
                    str(col.get("id", ""))[:16],
                    str(col.get("name", "")),
                    str(col.get("clip_count", 0)),
                    str(col.get("color") or "#6366f1"),
                    str(col.get("description") or ""),
                )
            console.print(t)
            return

        # ── --top-rated: list top-rated clips ─────────────────────────────────
        if args.top_rated:
            clips = client.get_top_rated_clips(raise_on_error=True)
            if not clips:
                console.print("[dim]No rated clips found yet.[/dim]")
                return
            t = Table(title="⭐ Top-Rated Clips", box=box.ROUNDED)
            t.add_column("ID", style="dim", width=16)
            t.add_column("Title", style="bold white")
            t.add_column("★ Rating", justify="center", style="bold yellow", width=11)
            t.add_column("🔥 Score", justify="right", style="magenta", width=9)
            t.add_column("Duration", justify="right", style="green", width=9)
            t.add_column("Platform", style="cyan", width=10)
            for c in clips:
                rating = int(c.get("rating") or 0)
                stars = f"{'★' * rating} ({rating}/5)" if rating > 0 else "—"
                sc = float(c.get("virality_score") or 0)
                t.add_row(
                    str(c.get("id", ""))[:16],
                    str(c.get("title", "")),
                    stars,
                    f"🔥 {int(round(sc))}" if sc > 0 else "—",
                    f"{float(c.get('duration_sec') or 0):.1f}s",
                    str(c.get("source_platform") or "local"),
                )
            console.print(t)
            return

        # ── --queue-list: Social Upload Queue + per-platform stats ────────────
        if args.queue_list:
            res = client.list_upload_queue()
            _exit_if_failed(console, res, "Upload queue")
            items = res.get("items") or []
            stats = res.get("stats") or {}

            if not items:
                console.print("[dim]Social upload queue is currently empty.[/dim]")
            else:
                qt = Table(title="📤 Social Upload Queue", box=box.ROUNDED)
                qt.add_column("ID", style="dim", width=14)
                qt.add_column("Platform", style="bold cyan", width=13)
                qt.add_column("Status", width=12)
                qt.add_column("Title", style="bold white")
                qt.add_column("Tags", style="dim")
                qt.add_column("Clip ID", style="dim", width=14)
                for it in items:
                    st = str(it.get("status") or "queued")
                    st_style = {"done": "bold green", "failed": "bold red", "in_progress": "bold yellow"}.get(st, "cyan")
                    qt.add_row(
                        str(it.get("id", ""))[:14],
                        str(it.get("platform", "")).upper(),
                        Text(st, style=st_style),
                        str(it.get("title", ""))[:50],
                        str(it.get("tags", ""))[:30],
                        str(it.get("clip_id", ""))[:14],
                    )
                console.print(qt)

            if isinstance(stats, dict) and stats:
                st_table = Table(title="📊 Queue Stats by Platform", box=box.ROUNDED)
                st_table.add_column("Platform", style="bold white", width=14)
                st_table.add_column("Queued", justify="right", style="cyan", width=8)
                st_table.add_column("In Progress", justify="right", style="yellow", width=12)
                st_table.add_column("Done", justify="right", style="green", width=8)
                st_table.add_column("Failed", justify="right", style="red", width=8)
                for plat, counts in stats.items():
                    if isinstance(counts, dict):
                        st_table.add_row(
                            str(plat).upper(),
                            str(counts.get("queued", 0)),
                            str(counts.get("in_progress", 0)),
                            str(counts.get("done", 0)),
                            str(counts.get("failed", 0)),
                        )
                console.print(st_table)
            return

        # ── --share: create share link for a clip ─────────────────────────────
        if args.share:
            res = client.create_share_link(
                args.share,
                expires_in_hours=args.share_hours,
                max_views=args.share_views,
                password=args.share_password,
            )
            _exit_if_failed(console, res, "Create share link")
            share = res.get("share") or res
            token = str(share.get("token") or "")
            share_url = f"{client.base_url}/api/share/{quote(token, safe='')}"
            console.print(f"[bold green]🔗 Share URL:[/bold green] {share_url}")
            details: List[str] = []
            if share.get("max_views") is not None:
                details.append(f"max_views={share['max_views']}")
            if share.get("expires_at") is not None:
                details.append(f"expires_at={share['expires_at']}")
            if share.get("has_password"):
                details.append("password_protected=yes")
            if details:
                console.print(f"[dim]Options: {', '.join(details)}[/dim]")
            return

        # ── --reexport: re-export / trim / speed / flip a clip ───────────────
        if args.reexport:
            payload: Dict[str, Any] = {}
            if args.trim_start is not None:
                payload["trimStartSec"] = float(args.trim_start)
            if args.trim_end is not None:
                payload["trimEndSec"] = float(args.trim_end)
            if args.speed is not None:
                payload["speed"] = float(args.speed)
            if args.flip:
                payload["flipHorizontal"] = True
            if args.silence_cut:
                payload["silenceCut"] = True
            if args.normalize:
                payload["audioNormalize"] = True
            if args.music:
                payload["musicTrack"] = args.music
                payload["musicVolume"] = float(args.music_volume)
            if user_explicit["captions"] or (has_preset and args.captions != "none"):
                payload["captionStyle"] = args.captions
            if args.hook:
                payload["hookTitleText"] = args.hook
            if args.watermark:
                payload["watermarkText"] = args.watermark
            console.print(f"[bold yellow]♻️ Re-exporting clip {args.reexport}...[/bold yellow]")
            res = client.reexport_clip(args.reexport, payload)
            _exit_if_failed(console, res, "Re-export clip")
            clip_obj = res.get("clip") or res
            console.print(f"[bold green]✅ Re-exported: {clip_obj.get('filePath') or clip_obj.get('file_path')}[/bold green]")
            return

        # ── --export-csv: export clips library to a CSV file ─────────────────
        if args.export_csv:
            out_path = args.export_csv
            console.print(f"[bold yellow]📤 Exporting clips CSV → {out_path}...[/bold yellow]")
            try:
                csv_text = client.export_clips_csv()
                pathlib.Path(out_path).write_text(csv_text, encoding="utf-8")
                non_empty = [ln for ln in csv_text.splitlines() if ln.strip()]
                rows = max(0, len(non_empty) - 1)
                console.print(f"[bold green]✅ Exported {rows} clip(s) → {out_path}[/bold green]")
            except OSError as exc:
                console.print(f"[bold red]❌ CSV export failed: {exc}[/bold red]")
                sys.exit(1)
            return

        # ── --batch-metadata: AI metadata on multiple clips ───────────────────
        if args.batch_metadata:
            clip_ids = [c.strip() for c in args.batch_metadata.replace(" ", ",").split(",") if c.strip()]
            if not clip_ids:
                console.print("[bold red]Error: --batch-metadata requires at least one clip ID[/bold red]")
                sys.exit(1)
            if len(clip_ids) > 20:
                console.print("[bold red]Error: --batch-metadata supports at most 20 clip IDs per batch[/bold red]")
                sys.exit(1)
            console.print(f"[bold yellow]🤖 Generating AI metadata for {len(clip_ids)} clip(s)...[/bold yellow]")
            res = client.batch_metadata(clip_ids)
            _exit_if_failed(console, res, "Batch metadata")
            updated = res.get("updatedCount", 0)
            results = res.get("results", [])
            console.print(f"[bold green]✅ Updated metadata for {updated} clip(s)[/bold green]")
            for r in results:
                status_icon = "✅" if r.get("ok") else "❌"
                console.print(f"  {status_icon} {r.get('id', '')} — {r.get('title') or r.get('error', '')}")
            return

        # ── --kit: download Creator Kit JSON for a clip ───────────────────────
        if args.kit:
            res = client.get_clip_kit(args.kit)
            _exit_if_failed(console, res, "Creator Kit")
            kit_path = _save_and_render_creator_kit(console, args.kit, res)
            console.print(f"[bold green]✅ Creator Kit saved → {kit_path}[/bold green]")
            return
    except (requests.RequestException, RuntimeError) as exc:
        console.print(Text(f"❌ Error: {exc}", style="bold red"))
        sys.exit(1)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="🎬 Clipper Studio Terminal User Interface & Automation CLI",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--status", action="store_true", help="Print live monitoring status and exit")
    parser.add_argument("--plan-status", action="store_true", help="Show active Stripe plan, license, and daily clip quota")
    parser.add_argument("--activate-key", metavar="KEY", help="Activate a Stripe sub_/cs_ ID or Admin VIP license key")
    parser.add_argument("--start", action="store_true", help="Start monitoring a stream")
    parser.add_argument("--stop", action="store_true", help="Stop the active monitoring session")
    parser.add_argument("--clip", nargs="?", const=20, type=int, help="Trigger manual clip (optional seconds, default 20)")
    parser.add_argument("--clips", action="store_true", help="List all rendered clips")
    parser.add_argument("--platform", default="twitch", choices=["twitch", "kick", "youtube"], help="Platform for --start / --list-streams")
    parser.add_argument("--channel", help="Channel name or stream URL for --start / --list-streams")
    parser.add_argument(
        "--layout",
        default=None,
        choices=["split", "split-crop", "portrait-4x5", "square", "crop", "blur", "landscape"],
        help="Layout preset (default: split)",
    )
    parser.add_argument(
        "--facecam",
        default=None,
        choices=["auto", "top-left", "top-right", "bottom-left", "bottom-right"],
        help="Facecam positioning (default: auto)",
    )
    parser.add_argument(
        "--captions",
        nargs="?",
        const="hormozi",
        default=None,
        choices=["none", "hormozi", "neon", "minimal"],
        help="Kinetic auto-caption style (PRO/ULTRA; defaults to hormozi if flag passed without value, else none)",
    )
    parser.add_argument("--watermark", default=None, help="Custom channel watermark text (ULTRA)")
    parser.add_argument("--hook", default=None, help="3.5s top hook headline banner text")
    parser.add_argument("--triggers", default="", help="Comma-separated chat trigger keywords (e.g. '!clip,clip it')")
    parser.add_argument("--normalize", action="store_true", default=None, help="Enable -14 LUFS broadcast audio normalization")
    parser.add_argument("--silence-cut", action="store_true", default=None, help="Auto-trim dead-air silence pauses from rendered clips")
    parser.add_argument("--music", default=None, metavar="PATH_OR_NAME", help="Background music track path or name from 06_music/")
    parser.add_argument("--music-volume", type=float, default=None, help="Background music mix volume (default 0.18)")
    parser.add_argument("--multiplier", type=float, default=2.5, help="Chat spike multiplier vs baseline (default 2.5)")
    parser.add_argument("--min-threshold", type=float, default=4.0, help="Minimum chat msg/s spike threshold (default 4.0)")
    parser.add_argument("--save-recording", action="store_true", help="Save full live recording to 05_streams/ for after-live clipping")
    parser.add_argument("--list-streams", action="store_true", help="List recent past live streams for --platform and --channel")
    parser.add_argument("--audio-peaks", action="store_true", help="Scan --source for loudest hype audio peaks")
    parser.add_argument("--auto-clip-top", type=int, metavar="N", help="Batch auto-clip top N audio peaks from --source")
    parser.add_argument("--manual-clip", action="store_true", help="Cut an after-live manual clip from --source")
    parser.add_argument("--montage", metavar="CLIP_IDS", help="Compile comma-separated clip IDs into a single montage reel")
    parser.add_argument("--analytics", action="store_true", help="Show workspace clip analytics summary")
    parser.add_argument("--check-update", action="store_true", help="Check current tool version and upstream Git updates")
    parser.add_argument("--update-tool", action="store_true", help="Run update.ps1 (Windows) or update.sh (macOS/Linux) to update the tool")
    parser.add_argument("--yes", "-y", action="store_true", help="Skip confirmation prompt for --update-tool")
    parser.add_argument("--source", help="Local video path or VOD URL for --manual-clip / --audio-peaks / --auto-clip-top")
    parser.add_argument("--start-sec", type=float, default=0.0, help="Start timestamp in seconds for --manual-clip")
    parser.add_argument("--end-sec", type=float, default=25.0, help="End timestamp in seconds for --manual-clip")
    parser.add_argument("--title", help="Custom clip title for --manual-clip / --montage")
    parser.add_argument("--api-url", default=DEFAULT_API_URL, help="Clipper service URL")
    # ── New feature flags ──────────────────────────────────────────────────────
    parser.add_argument("--doctor", action="store_true", help="Run system diagnostics and show binary/DB/security status")
    parser.add_argument("--preset", metavar="NAME", help="Apply a named saved editing preset before clipping (by name or id)")
    parser.add_argument("--presets", action="store_true", help="List all saved editing presets")
    parser.add_argument("--collections", action="store_true", help="List all clip collections")
    parser.add_argument("--top-rated", action="store_true", help="List top-rated clips with star ratings and virality scores")
    parser.add_argument("--queue-list", action="store_true", help="Show Social Upload Queue table and per-platform stats")
    parser.add_argument("--share", metavar="CLIP_ID", help="Create a shareable link for a clip and print its URL")
    parser.add_argument("--share-hours", type=float, default=None, metavar="FLOAT", help="Optional expiry hours for --share (0.1–8760)")
    parser.add_argument("--share-views", type=int, default=None, metavar="INT", help="Optional max views for --share (1–100000)")
    parser.add_argument("--share-password", default=None, metavar="STR", help="Optional password protection for --share")
    parser.add_argument("--reexport", metavar="CLIP_ID", help="Re-export (trim/speed/flip) an existing clip by its ID")
    parser.add_argument("--trim-start", type=float, metavar="SEC", help="Trim start seconds for --reexport (default 0)")
    parser.add_argument("--trim-end", type=float, metavar="SEC", help="Trim end seconds for --reexport (0 = full clip end)")
    parser.add_argument("--speed", type=float, metavar="FLOAT", help="Playback speed for --reexport (0.5–2.0, default 1.0)")
    parser.add_argument("--flip", action="store_true", help="Flip horizontal during --reexport")
    parser.add_argument("--export-csv", metavar="OUT_PATH", help="Export all clips metadata to a CSV file at OUT_PATH")
    parser.add_argument("--batch-metadata", metavar="CLIP_IDS", help="Run AI metadata generation on comma-separated clip IDs (max 20)")
    parser.add_argument("--kit", metavar="CLIP_ID", help="Download Creator Kit JSON for a clip (title, platform copy, hashtags)")

    args = parser.parse_args()
    client = ClipperClient(args.api_url)

    has_cli_action = any([
        args.status,
        args.plan_status,
        bool(args.activate_key),
        args.start,
        args.stop,
        args.clip is not None,
        args.clips,
        args.list_streams,
        args.manual_clip,
        args.audio_peaks,
        args.auto_clip_top is not None,
        bool(args.montage),
        args.analytics,
        args.check_update,
        args.update_tool,
        args.doctor,
        args.presets,
        args.collections,
        args.top_rated,
        args.queue_list,
        bool(args.share),
        bool(args.reexport),
        bool(args.export_csv),
        bool(args.batch_metadata),
        bool(args.kit),
    ])
    if has_cli_action:
        run_cli_mode(args, client)
    else:
        tui = ClipperTUI(client)
        tui.run()


if __name__ == "__main__":
    main()
