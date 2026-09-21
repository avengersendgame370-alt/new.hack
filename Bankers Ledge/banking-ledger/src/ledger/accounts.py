"""Account class hierarchy.

::

    Account (ABC)
    ├── SavingsAccount
    └── CheckingAccount
        └── PremiumCheckingAccount

OOP concepts demonstrated
-------------------------
* **Abstraction** - ``Account`` is an abstract base class; it cannot be
  instantiated and forces subclasses to define ``available_funds`` and
  ``apply_monthly_update``.
* **Encapsulation** - balance, owner and history live in private attributes.
  They are exposed only through read-only properties (``balance``,
  ``transactions``) or validated setters (``owner``). All balance changes flow
  through the single private method ``_post``.
* **Inheritance** - shared behaviour (deposit, withdraw, serialisation) lives in
  the base class; ``PremiumCheckingAccount`` extends ``CheckingAccount``.
* **Polymorphism** - ``withdraw`` is a template method that relies on each
  subclass's ``available_funds``; ``apply_monthly_update`` behaves differently
  per class (interest vs. fee) yet is called identically by the bank.
"""

from __future__ import annotations

import re
from abc import ABC, abstractmethod
from decimal import ROUND_HALF_UP, Decimal
from typing import Any, ClassVar, Mapping, Optional

from .exceptions import InsufficientFundsError, InvalidAccountDataError
from .models import Transaction, TransactionType
from .money import CENT, ZERO, to_money, to_rate

_ID_PATTERN = re.compile(r"[A-Za-z0-9_-]{1,32}")


def _validate_owner(owner: Any) -> str:
    if not isinstance(owner, str) or not owner.strip():
        raise InvalidAccountDataError("owner must be a non-empty string")
    return owner.strip()


class Account(ABC):
    """Abstract base class for every kind of account."""

    #: Stable tag used when saving/loading. Concrete subclasses set their own.
    account_type: ClassVar[str] = ""
    _registry: ClassVar[dict[str, type["Account"]]] = {}

    def __init_subclass__(cls, **kwargs: Any) -> None:
        """Auto-register concrete subclasses so they can be rebuilt from data."""
        super().__init_subclass__(**kwargs)
        tag = cls.__dict__.get("account_type")
        if tag:
            if tag in Account._registry:
                raise TypeError(f"Duplicate account_type {tag!r}")
            Account._registry[tag] = cls

    # ------------------------------------------------------------------ #
    # Construction
    # ------------------------------------------------------------------ #
    def __init__(self, account_id: str, owner: str, initial_deposit: Any = 0) -> None:
        if not isinstance(account_id, str) or not _ID_PATTERN.fullmatch(account_id):
            raise InvalidAccountDataError(
                "account_id must be 1-32 characters: letters, digits, '_' or '-'"
            )
        self._account_id = account_id
        self._owner = _validate_owner(owner)
        self._balance: Decimal = ZERO
        self._transactions: list[Transaction] = []

        opening = to_money(initial_deposit, "initial_deposit", allow_zero=True)
        if opening > 0:
            self.deposit(opening, "Initial deposit")

    @classmethod
    def for_type(cls, account_type: str) -> type["Account"]:
        """Look up a registered concrete class by its ``account_type`` tag."""
        try:
            return Account._registry[account_type]
        except (KeyError, TypeError):
            known = ", ".join(sorted(Account._registry))
            raise InvalidAccountDataError(
                f"Unknown account type {account_type!r} (known: {known})"
            ) from None

    # ------------------------------------------------------------------ #
    # Encapsulated state
    # ------------------------------------------------------------------ #
    @property
    def account_id(self) -> str:
        return self._account_id

    @property
    def owner(self) -> str:
        return self._owner

    @owner.setter
    def owner(self, value: str) -> None:
        self._owner = _validate_owner(value)

    @property
    def balance(self) -> Decimal:
        return self._balance

    @property
    def transactions(self) -> tuple[Transaction, ...]:
        """A read-only snapshot; callers cannot tamper with the real history."""
        return tuple(self._transactions)

    def history(self, kind: Optional[TransactionType] = None) -> list[Transaction]:
        """Return the history, optionally filtered by transaction type."""
        if kind is None:
            return list(self._transactions)
        return [tx for tx in self._transactions if tx.kind == kind]

    # ------------------------------------------------------------------ #
    # Polymorphic hooks
    # ------------------------------------------------------------------ #
    @property
    @abstractmethod
    def available_funds(self) -> Decimal:
        """Maximum amount that may currently be withdrawn."""

    @abstractmethod
    def apply_monthly_update(self) -> Optional[Transaction]:
        """Apply this account type's month-end rule (interest, fees, ...)."""

    def _params(self) -> dict[str, str]:
        """Subclass-specific constructor parameters to persist."""
        return {}

    # ------------------------------------------------------------------ #
    # Public operations
    # ------------------------------------------------------------------ #
    def deposit(self, amount: Any, description: str = "Deposit") -> Transaction:
        return self._credit(amount, TransactionType.DEPOSIT, description)

    def withdraw(self, amount: Any, description: str = "Withdrawal") -> Transaction:
        return self._debit(amount, TransactionType.WITHDRAWAL, description)

    def transfer_in(self, amount: Any, description: str = "Transfer in") -> Transaction:
        return self._credit(amount, TransactionType.TRANSFER_IN, description)

    def transfer_out(self, amount: Any, description: str = "Transfer out") -> Transaction:
        return self._debit(amount, TransactionType.TRANSFER_OUT, description)

    # ------------------------------------------------------------------ #
    # Internals - the only place the balance is ever modified
    # ------------------------------------------------------------------ #
    def _credit(self, amount: Any, kind: TransactionType, description: str) -> Transaction:
        return self._post(kind, to_money(amount), description)

    def _debit(self, amount: Any, kind: TransactionType, description: str) -> Transaction:
        value = to_money(amount)
        available = self.available_funds  # polymorphic: differs per subclass
        if value > available:
            raise InsufficientFundsError(self._account_id, value, available)
        return self._post(kind, -value, description)

    def _post(self, kind: TransactionType, signed: Decimal, description: str) -> Transaction:
        self._balance += signed
        entry = Transaction(
            kind=kind,
            amount=abs(signed),
            balance_after=self._balance,
            description=description,
        )
        self._transactions.append(entry)
        return entry

    # ------------------------------------------------------------------ #
    # Serialisation
    # ------------------------------------------------------------------ #
    def to_dict(self) -> dict[str, Any]:
        return {
            "account_type": self.account_type,
            "account_id": self._account_id,
            "owner": self._owner,
            "balance": str(self._balance),
            "params": self._params(),
            "transactions": [tx.to_dict() for tx in self._transactions],
        }

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "Account":
        """Rebuild the correct subclass from serialised data and verify integrity."""
        if not isinstance(data, Mapping):
            raise InvalidAccountDataError("Account record must be an object")
        missing = [k for k in ("account_type", "account_id", "owner", "balance") if k not in data]
        if missing:
            raise InvalidAccountDataError(
                f"Account record is missing fields: {', '.join(missing)}"
            )

        klass = cls.for_type(data["account_type"])
        params = data.get("params") or {}
        raw_transactions = data.get("transactions") or []
        if not isinstance(params, Mapping) or not isinstance(raw_transactions, list):
            raise InvalidAccountDataError(
                "'params' must be an object and 'transactions' must be a list"
            )

        try:
            account = klass(data["account_id"], data["owner"], **params)
        except TypeError as exc:
            raise InvalidAccountDataError(f"Invalid account parameters: {exc}") from exc

        balance = to_money(data["balance"], "balance", allow_zero=True, allow_negative=True)
        transactions = [Transaction.from_dict(item) for item in raw_transactions]
        account._restore(balance, transactions)
        return account

    def _restore(self, balance: Decimal, transactions: list[Transaction]) -> None:
        """Install persisted state after checking it is self-consistent."""
        expected = transactions[-1].balance_after if transactions else ZERO
        if balance != expected:
            raise InvalidAccountDataError(
                f"Account {self._account_id!r}: stored balance {balance} does not "
                f"match transaction history ({expected})"
            )
        self._balance = balance
        self._transactions = list(transactions)

    def __repr__(self) -> str:
        return (
            f"{type(self).__name__}(id={self._account_id!r}, "
            f"owner={self._owner!r}, balance={self._balance})"
        )


class SavingsAccount(Account):
    """Earns monthly interest; must keep a minimum balance."""

    account_type = "savings"

    def __init__(
        self,
        account_id: str,
        owner: str,
        initial_deposit: Any = 0,
        interest_rate: Any = "0.02",
        min_balance: Any = "0.00",
    ) -> None:
        # Subclass state is set first: it must exist before the base
        # constructor performs the opening deposit.
        self._interest_rate = to_rate(interest_rate, "interest_rate")
        self._min_balance = to_money(min_balance, "min_balance", allow_zero=True)
        super().__init__(account_id, owner, initial_deposit)

    @property
    def interest_rate(self) -> Decimal:
        """Annual interest rate as a fraction (0.02 == 2%)."""
        return self._interest_rate

    @property
    def min_balance(self) -> Decimal:
        return self._min_balance

    @property
    def available_funds(self) -> Decimal:
        return max(self._balance - self._min_balance, ZERO)

    def apply_monthly_update(self) -> Optional[Transaction]:
        if self._balance <= 0:
            return None
        interest = (self._balance * self._interest_rate / 12).quantize(
            CENT, rounding=ROUND_HALF_UP
        )
        if interest <= 0:
            return None
        return self._post(TransactionType.INTEREST, interest, "Monthly interest")

    def _params(self) -> dict[str, str]:
        return {
            "interest_rate": str(self._interest_rate),
            "min_balance": str(self._min_balance),
        }


class CheckingAccount(Account):
    """Allows overdraft up to a limit and charges a monthly fee."""

    account_type = "checking"

    def __init__(
        self,
        account_id: str,
        owner: str,
        initial_deposit: Any = 0,
        overdraft_limit: Any = "0.00",
        monthly_fee: Any = "0.00",
    ) -> None:
        self._overdraft_limit = to_money(overdraft_limit, "overdraft_limit", allow_zero=True)
        self._monthly_fee = to_money(monthly_fee, "monthly_fee", allow_zero=True)
        super().__init__(account_id, owner, initial_deposit)

    @property
    def overdraft_limit(self) -> Decimal:
        return self._overdraft_limit

    @property
    def monthly_fee(self) -> Decimal:
        return self._monthly_fee

    @property
    def available_funds(self) -> Decimal:
        return max(self._balance + self._overdraft_limit, ZERO)

    def _fee_due(self) -> Decimal:
        """Hook that subclasses can override to change fee rules."""
        return self._monthly_fee

    def apply_monthly_update(self) -> Optional[Transaction]:
        fee = self._fee_due()
        if fee <= 0:
            return None
        # Bank-imposed fees may push the balance past the overdraft limit;
        # only customer-initiated withdrawals are limited by available_funds.
        return self._post(TransactionType.FEE, -fee, "Monthly maintenance fee")

    def _params(self) -> dict[str, str]:
        return {
            "overdraft_limit": str(self._overdraft_limit),
            "monthly_fee": str(self._monthly_fee),
        }


class PremiumCheckingAccount(CheckingAccount):
    """Checking account with a bigger overdraft and a fee-waiver threshold."""

    account_type = "premium_checking"

    def __init__(
        self,
        account_id: str,
        owner: str,
        initial_deposit: Any = 0,
        overdraft_limit: Any = "1000.00",
        monthly_fee: Any = "15.00",
        fee_waiver_threshold: Any = "5000.00",
    ) -> None:
        self._fee_waiver_threshold = to_money(
            fee_waiver_threshold, "fee_waiver_threshold", allow_zero=True
        )
        super().__init__(account_id, owner, initial_deposit, overdraft_limit, monthly_fee)

    @property
    def fee_waiver_threshold(self) -> Decimal:
        return self._fee_waiver_threshold

    def _fee_due(self) -> Decimal:
        if self._balance >= self._fee_waiver_threshold:
            return ZERO
        return super()._fee_due()

    def _params(self) -> dict[str, str]:
        return {**super()._params(), "fee_waiver_threshold": str(self._fee_waiver_threshold)}
