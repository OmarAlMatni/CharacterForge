"""Generation backends shipped with CharacterForge.

Each module exposes a single object with `status()` and `generate(request, files)`, matching the contract in
docs/GENERATION_PROTOCOL.md. Nothing here is imported unless CF_GENERATION_BACKEND names it, so an unused backend
costs nothing at startup.

    CF_GENERATION_BACKEND=backends.comfyui:backend
"""
