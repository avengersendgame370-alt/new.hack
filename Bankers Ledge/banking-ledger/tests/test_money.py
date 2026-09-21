from decimal import Decimal

import pytest

from ledger.exceptions import InvalidAmountError
from ledger.money import parse_decimal, to_money, to_rate


@pytest.mark.parametrize(
    "raw, expected",
    [
        ("10", "10.00"),
        (10, "10.00"),
        (10.5, "10.50"),
        (Decimal("1.5"), "1.50"),
        ("0.01", "0.01"),
        (" 7.25 ", "7.25"),
    ],
)
def test_to_money_accepts_valid_values(raw, expected):
    assert to_money(raw) == Decimal(expected)


@pytest.mark.parametrize(
    "raw",
    [True, False, None, [1], {"a": 1}, "abc", "", "NaN", "Infinity", "-Infinity",
     1.005, "0.001", "0", 0, "-5", "1e40"],
)
def test_to_money_rejects_invalid_values(raw):
    with pytest.raises(InvalidAmountError):
        to_money(raw)


def test_to_money_zero_and_negative_flags():
    assert to_money("0", allow_zero=True) == Decimal("0.00")
    assert to_money("-5", allow_negative=True) == Decimal("-5.00")
    with pytest.raises(InvalidAmountError):
        to_money("-5", allow_zero=True)


def test_error_message_names_the_field():
    with pytest.raises(InvalidAmountError, match="deposit"):
        to_money("abc", "deposit")


def test_invalid_amount_is_also_a_value_error():
    with pytest.raises(ValueError):
        to_money("abc")


def test_parse_decimal_returns_decimal():
    assert parse_decimal("3.14159") == Decimal("3.14159")


@pytest.mark.parametrize("raw", ["0", "0.05", 1, Decimal("0.5")])
def test_to_rate_valid(raw):
    assert 0 <= to_rate(raw) <= 1


@pytest.mark.parametrize("raw", ["-0.1", "1.5", "abc", None, True])
def test_to_rate_invalid(raw):
    with pytest.raises(InvalidAmountError):
        to_rate(raw)
