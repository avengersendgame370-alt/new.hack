"""Custom exception hierarchy for the banking ledger.

Every error raised deliberately by this package derives from
:class:`LedgerError`, so callers can catch the whole family with a single
``except LedgerError`` or handle individual failure modes precisely.
"""

from __future__ import annotations

from decimal import Decimal


class LedgerError(Exception):
    """Base class for all ledger-related errors."""


# --------------------------------------------------------------------------- #
# Data validation errors
# --------------------------------------------------------------------------- #
class InvalidAmountError(LedgerError, ValueError):
    """A monetary amount or rate is malformed, out of range, or non-finite."""


class InvalidAccountDataError(LedgerError, ValueError):
    """Account/transaction/bank data is structurally invalid or inconsistent."""


# --------------------------------------------------------------------------- #
# Business rule errors
# --------------------------------------------------------------------------- #
class InsufficientFundsError(LedgerError):
    """A debit was attempted that exceeds the funds available."""

    def __init__(self, account_id: str, requested: Decimal, available: Decimal) -> None:
        self.account_id = account_id
        self.requested = requested
        self.available = available
        super().__init__(
            f"Account {account_id!r}: cannot withdraw {requested}; "
            f"only {available} available"
        )


class AccountNotFoundError(LedgerError):
    """The requested account does not exist in the bank."""

    def __init__(self, account_id: str) -> None:
        self.account_id = account_id
        super().__init__(f"Account {account_id!r} not found")


class DuplicateAccountError(LedgerError):
    """An account with the same id already exists in the bank."""

    def __init__(self, account_id: str) -> None:
        self.account_id = account_id
        super().__init__(f"Account {account_id!r} already exists")


class InvalidTransferError(LedgerError):
    """A transfer request is not allowed (e.g. source equals target)."""


# --------------------------------------------------------------------------- #
# Persistence errors
# --------------------------------------------------------------------------- #
class StorageError(LedgerError):
    """A file could not be read, written, or parsed."""


class UnsupportedFormatError(StorageError):
    """The requested persistence format is not supported."""
