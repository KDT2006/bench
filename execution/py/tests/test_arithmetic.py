"""Profile element-wise integer addition and division and check their results."""

import unittest
from array import array

from execution.py.tests.profile_helper import run_profile


class ArithmeticTests(unittest.TestCase):
    def test_addition(self):
        size = 4096
        left = array("Q", range(size))
        right = array("Q", (2 * i for i in range(size)))
        output = array("Q", [0]) * size

        def work():
            for i in range(size):
                output[i] = left[i] + right[i]

        def check_output():
            self.assertEqual(output, array("Q", (3 * i for i in range(size))))

        run_profile(self, 3 * output.itemsize * size, work, check_output)

    def test_division(self):
        size = 4096
        divisors = array("Q", range(1, size + 1))
        numerators = array(
            "Q", (divisors[i] * (i % 17) + divisors[i] - 1 for i in range(size))
        )
        output = array("Q", [0]) * size

        def work():
            for i in range(size):
                output[i] = numerators[i] // divisors[i]

        def check_output():
            self.assertEqual(output, array("Q", (i % 17 for i in range(size))))

        run_profile(self, 3 * output.itemsize * size, work, check_output)


if __name__ == "__main__":
    unittest.main()
