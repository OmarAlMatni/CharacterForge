#!/usr/bin/env python3
"""Download the model files a CharacterForge generation backend needs.

CharacterForge never downloads weights on its own: the artist runs this script, sees the size and the licence of
everything it will fetch, and passes --accept-licences to say they have read them. Nothing is fetched without it.

    python tools/fetch_models.py --list
    python tools/fetch_models.py --accept-licences --preset comfyui-sdxl
    python tools/fetch_models.py --accept-licences --preset comfyui-sdxl --dest /path/to/ComfyUI/models

Presets
    comfyui-sdxl   Animagine XL 4.0 (anime SDXL) + xinsir OpenPose ControlNet, laid out for ComfyUI.
    comfyui-sd15   Anything-v5 (anime SD1.5) + lllyasviel OpenPose ControlNet — much smaller, runs on 4 GB VRAM.
    tiny           segmind/tiny-sd, ~1 GB. Not an art model: for testing the plumbing on a CPU-only machine.

Every file is checked against the size Hugging Face reports before it is written, and a partial download is resumed
rather than restarted. Licences are printed before anything is fetched and are NOT accepted on your behalf.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import urllib.error
import urllib.request

HF = "https://huggingface.co"

#: repo, file, destination subdirectory (relative to --dest), approximate size, licence, what it is for.
PRESETS: dict[str, list[dict[str, str]]] = {
    "comfyui-sdxl": [
        {
            "repo": "cagliostrolab/animagine-xl-4.0",
            "file": "animagine-xl-4.0.safetensors",
            "dest": "checkpoints",
            "size": "6.9 GB",
            "licence": "CreativeML Open RAIL++-M (use restrictions apply; pass the licence on to anyone you share output with)",
            "role": "anime SDXL base checkpoint",
        },
        {
            "repo": "xinsir/controlnet-openpose-sdxl-1.0",
            "file": "diffusion_pytorch_model.safetensors",
            "dest": "controlnet",
            "size": "2.5 GB",
            "licence": "Apache-2.0",
            "role": "OpenPose ControlNet for SDXL (follows the pose map)",
        },
    ],
    "comfyui-sd15": [
        {
            "repo": "stablediffusionapi/anything-v5",
            "file": "anything-v5.safetensors",
            "dest": "checkpoints",
            "size": "2.1 GB",
            "licence": "CreativeML Open RAIL-M",
            "role": "anime SD1.5 base checkpoint (small, fast, 4 GB VRAM is enough)",
        },
        {
            "repo": "lllyasviel/control_v11p_sd15_openpose",
            "file": "diffusion_pytorch_model.safetensors",
            "dest": "controlnet",
            "size": "1.4 GB",
            "licence": "Apache-2.0",
            "role": "OpenPose ControlNet for SD1.5",
        },
    ],
    "tiny": [
        {
            "repo": "segmind/tiny-sd",
            "file": "unet/diffusion_pytorch_model.bin",
            "dest": "tiny-sd/unet",
            "size": "0.65 GB",
            "licence": "CreativeML Open RAIL-M",
            "role": "tiny SD UNet — plumbing test only, not an art model",
        },
        {
            "repo": "segmind/tiny-sd",
            "file": "vae/diffusion_pytorch_model.bin",
            "dest": "tiny-sd/vae",
            "size": "0.17 GB",
            "licence": "CreativeML Open RAIL-M",
            "role": "tiny SD VAE",
        },
        {
            "repo": "segmind/tiny-sd",
            "file": "text_encoder/pytorch_model.bin",
            "dest": "tiny-sd/text_encoder",
            "size": "0.25 GB",
            "licence": "CreativeML Open RAIL-M",
            "role": "tiny SD text encoder",
        },
    ],
}


def _human(n: int) -> str:
    return f"{n / 1e9:.2f} GB" if n >= 1e9 else f"{n / 1e6:.0f} MB"


def _remote_size(repo: str, file: str) -> int | None:
    """Size of the file on Hugging Face, from a HEAD request (follows the redirect to the CDN)."""
    url = f"{HF}/{repo}/resolve/main/{file}"
    req = urllib.request.Request(url, method="HEAD")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            n = r.headers.get("x-linked-size") or r.headers.get("content-length")
            return int(n) if n and n.isdigit() else None
    except (urllib.error.URLError, OSError, ValueError):
        return None


def _download(repo: str, file: str, target: str, expected: int | None) -> None:
    """Stream to a .part file, then rename. Resumes if a .part file is already there."""
    os.makedirs(os.path.dirname(target) or ".", exist_ok=True)
    part = target + ".part"
    have = os.path.getsize(part) if os.path.exists(part) else 0
    if expected is not None and have == expected:
        os.replace(part, target)
        print(f"  already complete: {target}")
        return
    url = f"{HF}/{repo}/resolve/main/{file}"
    req = urllib.request.Request(url)
    if have:
        req.add_header("Range", f"bytes={have}-")
        print(f"  resuming at {_human(have)}")
    try:
        with urllib.request.urlopen(req, timeout=60) as r, open(part, "ab") as f:
            total = expected or int(r.headers.get("content-length") or 0) + have
            done = have
            while True:
                chunk = r.read(1024 * 1024)
                if not chunk:
                    break
                f.write(chunk)
                done += len(chunk)
                if total:
                    pct = 100 * done / total
                    print(f"\r  {pct:5.1f}%  {_human(done)} / {_human(total)}", end="", flush=True)
            print()
    except urllib.error.HTTPError as e:
        if e.code == 416 and expected is not None and have == expected:
            os.replace(part, target)
            return
        raise SystemExit(f"  download failed: HTTP {e.code} for {url}") from e
    except (urllib.error.URLError, OSError) as e:
        raise SystemExit(f"  download failed: {e}. The partial file is kept; run again to resume.") from e
    got = os.path.getsize(part)
    if expected is not None and got != expected:
        raise SystemExit(f"  size mismatch: got {got} bytes, expected {expected}. The partial file is kept; run again.")
    os.replace(part, target)
    print(f"  saved {target} ({_human(got)})")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Download model files for a CharacterForge generation backend.")
    ap.add_argument("--preset", choices=sorted(PRESETS), help="which set of files to fetch")
    ap.add_argument("--dest", default="", help="where to put them (default: ComfyUI/models if found, else ./models)")
    ap.add_argument("--list", action="store_true", help="print the presets, sizes and licences, then exit")
    ap.add_argument("--accept-licences", action="store_true", help="confirm you have read the licences printed above")
    ap.add_argument("--dry-run", action="store_true", help="resolve sizes and print the plan without downloading")
    args = ap.parse_args(argv)

    if args.list or not args.preset:
        for name, files in PRESETS.items():
            total = sum(float(f["size"].split()[0]) for f in files)
            print(f"\n{name}  (~{total:.1f} GB)")
            for f in files:
                print(f"  {f['size']:>8}  {f['repo']}/{f['file']}")
                print(f"            {f['role']}")
                print(f"            licence: {f['licence']}")
        print("\nNothing is downloaded without --accept-licences.")
        return 0

    files = PRESETS[args.preset]
    dest = args.dest
    if not dest:
        guess = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "..", "ComfyUI", "models")
        dest = os.path.normpath(guess) if os.path.isdir(guess) else "models"
    print(f"Preset {args.preset} -> {os.path.abspath(dest)}\n")
    for f in files:
        print(f"  {f['size']:>8}  {f['repo']}/{f['file']}")
        print(f"            licence: {f['licence']}")
    if not args.accept_licences and not args.dry_run:
        print("\nRefusing to download: pass --accept-licences once you have read the licences above.")
        print("Each licence governs what you may do with the model and, in some cases, with its output.")
        return 2

    free = shutil.disk_usage(os.path.abspath(dest) if os.path.isdir(dest) else ".").free
    print(f"\nFree space: {_human(free)}")
    failures = 0
    for f in files:
        target = os.path.join(dest, f["dest"], os.path.basename(f["file"]))
        print(f"\n{f['repo']}/{f['file']}")
        size = _remote_size(f["repo"], f["file"])
        if size is None:
            print("  could not read the size from Hugging Face; downloading without a size check")
        elif size > free:
            print(f"  skipped: needs {_human(size)}, only {_human(free)} free")
            failures += 1
            continue
        if args.dry_run:
            print(f"  would download {_human(size) if size else '?'} to {target}")
            continue
        try:
            _download(f["repo"], f["file"], target, size)
            if size:
                free -= size
        except SystemExit as e:
            print(e)
            failures += 1
    if failures:
        print(f"\n{failures} file(s) not fetched. Re-run to resume; nothing is left half-written.")
        return 1
    print("\nDone. Point the backend at these files:")
    print("  CF_GENERATION_BACKEND=backends.comfyui:backend")
    print("  CF_COMFYUI_WORKFLOW=<your workflow>.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
