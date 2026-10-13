"""Stockfish, compiled into this package when it was installed (see src/chess-move-stockfish/setup.py)."""

from pathlib import Path

BINARY = Path(__file__).with_name("stockfish")

__all__ = ["BINARY"]
