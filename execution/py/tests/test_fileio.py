"""Profile writing and reading a temporary file, including open and close."""

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from execution.py.tests.profile_helper import run_profile


class FileIOTests(unittest.TestCase):
    def test_file_io(self):
        payload = b"profiler-file-io\n" * 4096
        output = b""

        with TemporaryDirectory() as directory:
            path = Path(directory) / "profile.bin"

            def work():
                nonlocal output
                # Includes filesystem caching; deliberately does not call fsync.
                path.write_bytes(payload)
                output = path.read_bytes()

            def check_output():
                self.assertEqual(output, payload)

            run_profile(self, 2 * len(payload), work, check_output)


if __name__ == "__main__":
    unittest.main()
