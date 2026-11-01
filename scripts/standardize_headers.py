# C:\Users\dbkr\workspace\daa-public-staging\scripts\standardize_headers.py
# Status: 🟢 ACTIVE | Sprint: 1011 | Last Revised: 2026-04-02
# Owner: @CTO-Agent | Project: DAA Infinite Synthesis


#!/usr/bin/env python3
import os
import sys


def process_file(file_path):
    # Ensure it's an absolute path for the header
    abs_path = os.path.abspath(file_path)
    header = f"## {abs_path}\n"

    try:
        with open(file_path, "r", encoding="utf-8") as f:
            lines = f.readlines()
    except Exception as e:
        print(f"Error reading {file_path}: {e}")
        return False

    # Check if header already exists
    if lines and lines[0].startswith("## C:\\"):
        if lines[0] == header:
            return False  # No change needed
        else:
            # Update incorrect header
            lines[0] = header
    else:
        # Add new header
        lines.insert(0, header)

    try:
        with open(file_path, "w", encoding="utf-8") as f:
            f.writelines(lines)
        return True
    except Exception as e:
        print(f"Error writing {file_path}: {e}")
        return False


def main():
    files = sys.argv[1:]
    updated_count = 0
    for file_path in files:
        if file_path.endswith((".md", ".txt")):
            if process_file(file_path):
                print(f"Updated header in: {file_path}")
                updated_count += 1

    if updated_count > 0:
        print(f"Standardized headers in {updated_count} files.")

    # Pre-commit hook should return 0 if it just fixes things,
    # but some people prefer 1 to force a re-stage.
    # We'll return 0 to allow the commit to proceed with the changes.
    sys.exit(0)


if __name__ == "__main__":
    main()
