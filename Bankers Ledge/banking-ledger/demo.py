"""End-to-end demonstration.  Run with:  python demo.py   (after `pip install -e .`)"""

import tempfile
from pathlib import Path

from ledger import (
    Bank,
    InsufficientFundsError,
    InvalidAmountError,
    LedgerError,
    get_storage,
)


def main() -> None:
    bank = Bank("Demo Bank")
    bank.create_account("savings", "SAV-001", "Alice", initial_deposit="2500", interest_rate="0.045", min_balance="500")
    bank.create_account("checking", "CHK-001", "Alice", initial_deposit="300", overdraft_limit="200", monthly_fee="5")
    bank.create_account("premium_checking", "PRM-001", "Bob", initial_deposit="6000")

    print("== Transfers ==")
    bank.transfer("SAV-001", "CHK-001", "400", "Top-up")
    print(*bank.accounts, sep="\n")

    print("\n== Month-end (polymorphic: interest vs fees) ==")
    for account_id, tx in bank.apply_monthly_updates().items():
        outcome = f"{tx.kind.value} {tx.amount}" if tx else "nothing due"
        print(f"{account_id}: {outcome}")

    print("\n== Error handling ==")
    attempts = [
        ("overdraw savings", lambda: bank.get_account("SAV-001").withdraw("5000")),
        ("bad amount", lambda: bank.get_account("CHK-001").deposit("12.345")),
        ("unknown account", lambda: bank.transfer("SAV-001", "NOPE", "1")),
    ]
    for label, action in attempts:
        try:
            action()
        except (InsufficientFundsError, InvalidAmountError) as exc:
            print(f"[{type(exc).__name__}] {label}: {exc}")
        except LedgerError as exc:  # catches every other domain error
            print(f"[{type(exc).__name__}] {label}: {exc}")

    print("\n== Persistence ==")
    with tempfile.TemporaryDirectory() as tmp:
        json_path = Path(tmp) / "bank.json"
        csv_dir = Path(tmp) / "bank_csv"
        get_storage("json").save(bank, json_path)
        get_storage("csv").save(bank, csv_dir)
        from_json = get_storage("json").load(json_path)
        from_csv = get_storage("csv").load(csv_dir)
        print(f"JSON reload: {len(from_json)} accounts, holdings {from_json.total_holdings()}")
        print(f"CSV  reload: {len(from_csv)} accounts, holdings {from_csv.total_holdings()}")


if __name__ == "__main__":
    main()
