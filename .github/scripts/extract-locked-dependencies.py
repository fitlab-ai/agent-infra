#!/usr/bin/env python3
"""Extract a validated node_modules archive into an isolated directory."""
import os
import sys
import tarfile
import tempfile
from pathlib import Path, PurePosixPath


def extract(archive: str, workspace: str) -> None:
    root = Path(workspace)
    destination = root / "node_modules"
    if os.path.lexists(destination):
        raise ValueError("node_modules already exists")
    with tarfile.open(archive, "r:") as tar:
        entries = tar.getmembers()
        names = set()
        for entry in entries:
            name = entry.name.rstrip("/")
            parts = PurePosixPath(name).parts
            if not parts or parts[0] != "node_modules" or name.startswith("/") or ".." in parts or "\\" in name:
                raise ValueError(f"invalid archive path: {entry.name}")
            normalized = str(PurePosixPath(name))
            if normalized in names or not (entry.isdir() or entry.isfile()):
                raise ValueError(f"duplicate or unsupported archive entry: {entry.name}")
            names.add(normalized)
        if "node_modules" not in names or not next(entry for entry in entries if str(PurePosixPath(entry.name)) == "node_modules").isdir():
            raise ValueError("node_modules root is missing")
        with tempfile.TemporaryDirectory(prefix=".dependencies-", dir=root) as temp:
            tar.extractall(temp, filter="data")
            os.replace(Path(temp) / "node_modules", destination)


if __name__ == "__main__":
    try:
        extract(sys.argv[1], sys.argv[2])
    except (ValueError, OSError, tarfile.TarError, IndexError) as error:
        print(f"dependency archive rejected: {error}", file=sys.stderr)
        sys.exit(1)
