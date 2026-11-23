#!/usr/bin/env python3
"""
🎬 Clipper Studio — Terminal User Interface (TUI) & Python CLI Control
A local-first terminal dashboard and controller for real-time live stream clipping,
chat explosion tracking, OpenCV facecam monitoring, and clips management.
"""

import sys
import os
import time
import json
import argparse
import subprocess
from datetime import datetime
from typing import Optional, Dict, Any, List

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

DEFAULT_API_URL = os.environ.get("CLIPPER_SERVICE_URL", "http://localhost:4001")
MEDIA_CLIPS_DIR = os.environ.get("MEDIA_ROOT_DIR", r"D:\ClipperMedia\03_clips")
if not os.path.exists(MEDIA_CLIPS_DIR):
    MEDIA_CLIPS_DIR = r"D:\ClipperMedia\03_clips"

LAYOUT_OPTIONS = [
    ("split", "📱 Split: Facecam Top + Ambient 16:9 Game Bottom (Shorts)"),
    ("split-crop", "📱 Split: Facecam Top + Action Center Crop"),
    ("crop", "📱 9:16 Action Center Crop"),
    ("blur", "📱 9:16 Full Blurred Background"),
    ("landscape", "🖥️ 16:9 Landscape"),
]

FACECAM_OPTIONS = [
    ("auto", "👤 Auto-Detect (OpenCV)"),
    ("top-left", "↖️ Top-Left"),
    ("top-right", "↗️ Top-Right"),
    ("bottom-left", "↙️ Bottom-Left"),
    ("bottom-right", "↘️ Bottom-Right"),
]


class ClipperClient:
    """Client for Clipper Studio REST API."""

    def __init__(self, base_url: str = DEFAULT_API_URL):
        self.base_url = base_url.rstrip("/")

    def get_status(self) -> Dict[str, Any]:
        try:
            res = requests.get(f"{self.base_url}/api/live/status", timeout=2.0)
            if res.status_code == 200:
                return res.json()
        except Exception:
            pass
        return {"active": False, "connected": False}

    def get_facecam(self) -> Optional[Dict[str, Any]]:
        try:
            res = requests.get(f"{self.base_url}/api/live/preview-facecam", timeout=2.0)
            if res.status_code == 200:
                data = res.json()
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
        spike_multiplier: float = 2.5,
        min_spike: float = 4.0,
    ) -> Dict[str, Any]:
        payload = {
            "platform": platform,
            "channelOrUrl": channel,
            "vertical": layout != "landscape",
            "layout": layout,
            "facecamPosition": facecam,
            "spikeMultiplier": spike_multiplier,
            "minSpikeThreshold": min_spike,
        }
        res = requests.post(f"{self.base_url}/api/live/start", json=payload, timeout=6.0)
        return res.json()

    def stop_session(self) -> Dict[str, Any]:
        res = requests.post(f"{self.base_url}/api/live/stop", timeout=4.0)
        return res.json()

    def clip_now(self, duration_sec: int = 20) -> Dict[str, Any]:
        res = requests.post(
            f"{self.base_url}/api/live/clip-now",
            json={"durationSec": duration_sec},
            timeout=30.0,
        )
        return res.json()

    def get_clips(self) -> List[Dict[str, Any]]:
        try:
            res = requests.get(f"{self.base_url}/api/clipper/clips", timeout=3.0)
            if res.status_code == 200:
                return res.json()
        except Exception:
            pass
        return []


class ClipperTUI:
    """Rich-powered Terminal User Interface for Clipper Studio."""

    def __init__(self, client: ClipperClient):
        self.client = client
        self.console = Console()
        self.running = True
        self.last_facecam: Optional[Dict[str, Any]] = None
        self.facecam_poll_tick = 0
        self.status_message = "Ready. Press [S] to start monitoring or [Q] to quit."
        self.status_color = "cyan"
        self.layout_idx = 0
        self.facecam_idx = 0

    def make_header(self, status: Dict[str, Any]) -> Panel:
        connected = status.get("connected", True)
        if not connected:
            conn_text = Text("● API OFFLINE (Check Clipper Service on :4001)", style="bold red")
        else:
            conn_text = Text(f"● API Connected ({self.client.base_url})", style="bold green")

        title = Text("🎬 CLIPPER STUDIO", style="bold magenta")
        subtitle = Text(" — Local-First Live Video Clipper & Chat Explosion Detector", style="dim")
        header_text = Text.assemble(title, subtitle, "  |  ", conn_text)
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
                ("Selected Layout: ", "bold"),
                (f"{LAYOUT_OPTIONS[self.layout_idx][1]}\n", "cyan"),
                ("Selected Facecam: ", "bold"),
                (f"{FACECAM_OPTIONS[self.facecam_idx][1]}\n\n", "green"),
                ("Press ", "dim"),
                ("[S]", "bold yellow"),
                (" to start monitoring a Twitch, Kick, or YouTube channel.\n", "dim"),
                ("Press ", "dim"),
                ("[L]", "bold cyan"),
                (" to cycle layouts | Press ", "dim"),
                ("[F]", "bold green"),
                (" to cycle facecam mode.", "dim"),
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
            platform = status.get("platform", "").upper()
            target = status.get("channelOrUrl", "")
            layout_name = status.get("layout", "split")
            facecam_pos = status.get("facecamPosition", "auto")

            face_desc = facecam_pos
            if self.last_facecam and self.last_facecam.get("found"):
                fc = self.last_facecam
                face_desc = f"{fc.get('corner')} (x={fc.get('crop_x')}, y={fc.get('crop_y')}, w={fc.get('crop_w')}, h={fc.get('crop_h')})"

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
                (f"{face_desc}\n\n", "green"),
                ("Timing Rules: ", "bold"),
                ("Starts -10s before spike | 20s min to 40s max duration\n", "dim"),
                ("Dynamic Extension: ", "bold"),
                ("Auto-extends while chat stays hyped\n", "dim"),
            )

            current_vel = float(status.get("currentVelocity", 0.0))
            baseline_vel = float(status.get("baselineVelocity", 0.0))
            multiplier = (current_vel / baseline_vel) if baseline_vel > 0 else 1.0

            # Velocity visual bar (0 to 25 msg/s max)
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
        table.add_column("File / Clip Title", style="cyan", ratio=6)
        table.add_column("Location", style="dim", ratio=4)

        if not recent:
            # Also read latest 3 from disk/API
            db_clips = self.client.get_clips()[:3]
            if db_clips:
                for c in db_clips:
                    ts = c.get("created_at", "")[:19].replace("T", " ")
                    title = c.get("title", "clip")
                    fpath = c.get("file_path", "")
                    table.add_row(ts[11:19] if len(ts) >= 19 else ts, title, fpath)
            else:
                table.add_row("—", "No clips generated yet. Waiting for chat explosion or manual clip.", "—")
        else:
            for item in recent[-5:]:
                ts = item.get("timestamp", "")
                fpath = item.get("filePath", "")
                name = os.path.basename(fpath)
                table.add_row(ts[11:19] if len(ts) >= 19 else ts, name, fpath)

        return Panel(table, title="Recently Caught Clips (Saved to D:\\ClipperMedia\\03_clips)", box=box.ROUNDED, style="magenta")

    def make_footer(self) -> Panel:
        hotkeys = Text.assemble(
            ("[S] ", "bold yellow"), ("Start Stream  ", "white"),
            ("[X] ", "bold red"), ("Stop  ", "white"),
            ("[SPACE/C] ", "bold green blink"), ("CLIP NOW (20s)  ", "bold white"),
            ("[L] ", "bold cyan"), ("Layout  ", "white"),
            ("[F] ", "bold magenta"), ("Facecam  ", "white"),
            ("[G] ", "bold blue"), ("Gallery  ", "white"),
            ("[Q] ", "bold white"), ("Quit", "white"),
        )
        status_line = Text(f"\n{self.status_message}", style=self.status_color)
        combined = Text.assemble(hotkeys, status_line)
        return Panel(combined, box=box.ROUNDED, style="green")

    def render(self, status: Dict[str, Any]) -> Layout:
        layout = Layout()
        layout.split_column(
            Layout(name="header", size=3),
            Layout(name="monitor", size=13),
            Layout(name="clips", size=8),
            Layout(name="footer", size=4),
        )
        layout["header"].update(self.make_header(status))
        layout["monitor"].update(self.make_live_monitor_panel(status))
        layout["clips"].update(self.make_clips_panel(status))
        layout["footer"].update(self.make_footer())
        return layout

    def prompt_start(self):
        """Interactive prompt in terminal to configure and start stream."""
        self.console.clear()
        self.console.print("\n[bold magenta]🚀 Start Live Stream Clipper[/bold magenta]\n")

        self.console.print("[bold]1. Select Platform:[/bold]")
        self.console.print("   [1] Twitch")
        self.console.print("   [2] Kick")
        self.console.print("   [3] YouTube")
        plat_choice = self.console.input("Choose platform [1-3, default=1]: ").strip()
        platform = "twitch"
        if plat_choice == "2":
            platform = "kick"
        elif plat_choice == "3":
            platform = "youtube"

        channel = self.console.input(f"Enter {platform.upper()} channel name or stream URL: ").strip()
        if not channel:
            self.status_message = "Cancelled start: no channel provided."
            self.status_color = "red"
            return

        self.console.print("\n[bold]2. Select Layout:[/bold]")
        for i, (k, desc) in enumerate(LAYOUT_OPTIONS, 1):
            self.console.print(f"   [{i}] {desc}")
        layout_choice = self.console.input(f"Choose layout [1-{len(LAYOUT_OPTIONS)}, default=1]: ").strip()
        try:
            l_idx = int(layout_choice) - 1 if layout_choice else 0
            if 0 <= l_idx < len(LAYOUT_OPTIONS):
                self.layout_idx = l_idx
        except ValueError:
            pass

        self.console.print("\n[bold]3. Select Facecam Mode:[/bold]")
        for i, (k, desc) in enumerate(FACECAM_OPTIONS, 1):
            self.console.print(f"   [{i}] {desc}")
        fc_choice = self.console.input(f"Choose facecam [1-{len(FACECAM_OPTIONS)}, default=1]: ").strip()
        try:
            f_idx = int(fc_choice) - 1 if fc_choice else 0
            if 0 <= f_idx < len(FACECAM_OPTIONS):
                self.facecam_idx = f_idx
        except ValueError:
            pass

        selected_layout = LAYOUT_OPTIONS[self.layout_idx][0]
        selected_facecam = FACECAM_OPTIONS[self.facecam_idx][0]

        self.console.print(f"\n[bold yellow]Connecting to {platform}: {channel}...[/bold yellow]")
        try:
            res = self.client.start_session(
                platform=platform,
                channel=channel,
                layout=selected_layout,
                facecam=selected_facecam,
            )
            if res.get("ok"):
                self.status_message = f"✅ Started monitoring {platform}: {channel}"
                self.status_color = "bold green"
            else:
                self.status_message = f"❌ Error starting: {res.get('error', 'Unknown error')}"
                self.status_color = "bold red"
        except Exception as e:
            self.status_message = f"❌ Connection failed: {e}"
            self.status_color = "bold red"

    def show_gallery(self):
        """Displays full interactive clips gallery."""
        self.console.clear()
        clips = self.client.get_clips()
        if not clips:
            self.console.print("\n[bold yellow]No clips rendered yet in D:\\ClipperMedia\\03_clips\\[/bold yellow]\n")
            self.console.input("Press [Enter] to return...")
            return

        table = Table(title="📁 Clipper Studio Gallery", box=box.ROUNDED)
        table.add_column("#", justify="right", style="cyan", width=3)
        table.add_column("Title", style="bold white", ratio=4)
        table.add_column("Duration", justify="right", style="green", width=10)
        table.add_column("Size", justify="right", style="yellow", width=10)
        table.add_column("Date", style="dim", width=12)
        table.add_column("Path", style="dim", ratio=5)

        for i, c in enumerate(clips, 1):
            dur = f"{c.get('duration_sec', 20):.1f}s"
            size_mb = f"{c.get('file_size_bytes', 0) / (1024*1024):.1f} MB"
            date = c.get("created_at", "")[:10]
            table.add_row(str(i), c.get("title", ""), dur, size_mb, date, c.get("file_path", ""))

        self.console.print(table)
        self.console.print("\n[bold cyan]Options:[/bold cyan]")
        self.console.print("  Type clip number (e.g. 1) to open in video player.")
        self.console.print("  Type 'e' + number (e.g. e1) to reveal in Windows Explorer.")
        self.console.print("  Press [Enter] to return to dashboard.\n")

        cmd = self.console.input("Select action: ").strip()
        if cmd.isdigit():
            idx = int(cmd) - 1
            if 0 <= idx < len(clips):
                fpath = clips[idx].get("file_path", "")
                if os.path.exists(fpath):
                    os.startfile(fpath)
                    self.status_message = f"Opened clip: {os.path.basename(fpath)}"
                    self.status_color = "green"
        elif cmd.startswith("e") and cmd[1:].isdigit():
            idx = int(cmd[1:]) - 1
            if 0 <= idx < len(clips):
                fpath = clips[idx].get("file_path", "")
                if os.path.exists(fpath):
                    subprocess.run(["explorer", f"/select,{fpath}"])
                    self.status_message = f"Revealed in Explorer: {os.path.basename(fpath)}"
                    self.status_color = "green"

    def handle_keypress(self, key: str, status: Dict[str, Any]):
        k = key.lower()
        if k in ("q", "\x03"):  # q or Ctrl-C
            self.running = False
        elif k == "s":
            self.prompt_start()
        elif k == "x":
            try:
                res = self.client.stop_session()
                self.status_message = res.get("message", "Monitoring stopped.")
                self.status_color = "yellow"
            except Exception as e:
                self.status_message = f"Error stopping: {e}"
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
                        self.status_message = f"✅ Clip saved: {os.path.basename(clip_path)}"
                        self.status_color = "bold green"
                    else:
                        self.status_message = f"❌ Clip failed: {res.get('error')}"
                        self.status_color = "bold red"
                except Exception as e:
                    self.status_message = f"❌ Clip error: {e}"
                    self.status_color = "bold red"
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

    def run(self):
        """Main TUI loop with 4Hz refresh rate."""
        self.console.clear()
        with Live(console=self.console, screen=True, refresh_per_second=4) as live:
            while self.running:
                status = self.client.get_status()

                # Poll facecam info every 2 seconds if stream is active
                if status.get("active"):
                    self.facecam_poll_tick += 1
                    if self.facecam_poll_tick % 8 == 0 or self.last_facecam is None:
                        fc = self.client.get_facecam()
                        if fc:
                            self.last_facecam = fc
                else:
                    self.last_facecam = None

                live.update(self.render(status))

                # Check for keyboard input (non-blocking on Windows)
                if HAS_MSVCRT and msvcrt.kbhit():
                    ch = msvcrt.getch()
                    try:
                        key_str = ch.decode("utf-8", errors="ignore")
                        live.stop()
                        self.handle_keypress(key_str, status)
                        live.start()
                    except Exception:
                        pass

                time.sleep(0.25)


def run_cli_mode(args: argparse.Namespace, client: ClipperClient):
    """Handles direct non-interactive CLI flags."""
    console = Console()
    if args.status:
        s = client.get_status()
        if not s.get("active"):
            console.print("[bold yellow]Status: IDLE[/bold yellow] (No stream monitored)")
        else:
            console.print(f"[bold red]Status: MONITORING[/bold red] on {s.get('platform')}: {s.get('channelOrUrl')}")
            console.print(f"Layout: {s.get('layout')} | Facecam: {s.get('facecamPosition')}")
            console.print(f"Velocity: {s.get('currentVelocity', 0):.1f} msg/s (Baseline: {s.get('baselineVelocity', 0):.1f} msg/s)")
        return

    if args.start:
        if not args.channel:
            console.print("[bold red]Error: --channel required when using --start[/bold red]")
            sys.exit(1)
        res = client.start_session(
            platform=args.platform,
            channel=args.channel,
            layout=args.layout,
            facecam=args.facecam,
        )
        if res.get("ok"):
            console.print(f"[bold green]✅ Started monitoring {args.platform}: {args.channel}[/bold green]")
        else:
            console.print(f"[bold red]❌ Failed to start: {res.get('error')}[/bold red]")
        return

    if args.stop:
        res = client.stop_session()
        console.print(f"[bold yellow]{res.get('message', 'Monitoring stopped.')}[/bold yellow]")
        return

    if args.clip:
        dur = int(args.clip) if str(args.clip).isdigit() else 20
        console.print(f"[bold yellow]Triggering clip ({dur}s)...[/bold yellow]")
        res = client.clip_now(dur)
        if res.get("ok"):
            fpath = res.get("clip", {}).get("filePath", "")
            console.print(f"[bold green]✅ Clip saved: {fpath}[/bold green]")
        else:
            console.print(f"[bold red]❌ Failed: {res.get('error')}[/bold red]")
        return

    if args.clips:
        clips = client.get_clips()
        if not clips:
            console.print("[dim]No clips in library.[/dim]")
            return
        t = Table(title="Rendered Clips", box=box.ROUNDED)
        t.add_column("Title", style="bold cyan")
        t.add_column("Duration", style="green")
        t.add_column("Size", style="yellow")
        t.add_column("File Path", style="dim")
        for c in clips:
            t.add_row(
                c.get("title", ""),
                f"{c.get('duration_sec', 20):.1f}s",
                f"{c.get('file_size_bytes', 0)/(1024*1024):.1f} MB",
                c.get("file_path", "")
            )
        console.print(t)
        return


def main():
    parser = argparse.ArgumentParser(
        description="🎬 Clipper Studio Terminal User Interface & Automation CLI",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--status", action="store_true", help="Print live monitoring status and exit")
    parser.add_argument("--start", action="store_true", help="Start monitoring a stream")
    parser.add_argument("--stop", action="store_true", help="Stop the active monitoring session")
    parser.add_argument("--clip", nargs="?", const=20, type=int, help="Trigger manual clip (optional seconds, default 20)")
    parser.add_argument("--clips", action="store_true", help="List all rendered clips")
    parser.add_argument("--platform", default="twitch", choices=["twitch", "kick", "youtube"], help="Platform for --start")
    parser.add_argument("--channel", help="Channel name or stream URL for --start")
    parser.add_argument("--layout", default="split", choices=["split", "split-crop", "crop", "blur", "landscape"], help="Layout preset")
    parser.add_argument("--facecam", default="auto", choices=["auto", "top-left", "top-right", "bottom-left", "bottom-right"], help="Facecam positioning")
    parser.add_argument("--api-url", default=DEFAULT_API_URL, help="Clipper service URL")

    args = parser.parse_args()
    client = ClipperClient(args.api_url)

    # If any CLI action flag was passed, run non-interactive CLI mode
    if args.status or args.start or args.stop or args.clip is not None or args.clips:
        run_cli_mode(args, client)
    else:
        # Launch full interactive TUI
        tui = ClipperTUI(client)
        tui.run()


if __name__ == "__main__":
    main()
