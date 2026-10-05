"""Regression tests for the captured HART transport and numeric evidence."""

import struct
import unittest
from pathlib import Path

from ld301_decode import decode_frame, decoded_rows


LOG = Path(__file__).resolve().parents[1] / "core/test/core/protocols/fixtures/ld301_capture.txt"


class CapturedSessionTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.rows = list(decoded_rows(LOG))

    def test_udp_chunks_reconstruct_one_response_per_serial_request(self):
        self.assertEqual(len(self.rows), 135)
        self.assertEqual(len({row["request_command"] for row in self.rows}), 30)
        self.assertGreater(self.rows[0]["udp_chunks"], 1)
        self.assertEqual(self.rows[0]["response_preambles"], 5)
        self.assertEqual(self.rows[0]["response_delimiter"], "06")
        self.assertEqual(self.rows[1]["response_delimiter"], "86")

    def test_identity_and_corrupt_capture_are_explicit(self):
        self.assertEqual(self.rows[0]["response_body"], "FE 3E 01 05 05 05 72 20 06 05 F0 4D")
        invalid = [row["index"] for row in self.rows
                   if not row.get("response_complete") or not row.get("response_checksum_valid")]
        self.assertEqual(invalid, [112, 117, 134])

    def test_fixed_current_write_read_sequence_uses_big_endian_float(self):
        for index, value in ((116, 4.0), (121, 8.0), (125, 12.0), (128, 16.0), (131, 20.0)):
            write = self.rows[index]
            self.assertEqual(write["request_command"], "28")
            self.assertEqual(struct.unpack(">f", bytes.fromhex(write["request_data"]))[0], value)
            read = self.rows[index + 1]
            self.assertEqual(read["request_command"], "21")
            data = bytes.fromhex(read["response_body"])
            self.assertEqual(data[:2], b"\x00\x27")
            self.assertEqual(struct.unpack(">f", data[2:6])[0], value)

    def test_frame_parser_rejects_incomplete_frame(self):
        with self.assertRaises(ValueError):
            decode_frame(bytes.fromhex("FF FF 86 BE 01 05 F0 4D 28 06 00"))


if __name__ == "__main__":
    unittest.main()
