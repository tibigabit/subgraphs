import {
  Liquidation,
  Redemption,
  TroveUpdated,
} from "../../generated/TroveManager/TroveManager";
import {
  createBorrow,
  createDeposit,
  createLiquidate,
  createRepay,
  createWithdraw,
} from "../entities/event";
import { getOrCreateTrove } from "../entities/trove";
import { getCurrentETHPrice } from "../entities/price";
import { bigIntToBigDecimal } from "../utils/numbers";
import { BIGINT_ZERO } from "../utils/constants";
import { _Trove } from "../../generated/schema";
import {
  addProtocolSideRevenue,
  addSupplySideRevenue,
} from "../entities/protocol";

enum TroveManagerOperation {
  applyPendingRewards,
  liquidateInNormalMode,
  liquidateInRecoveryMode,
  redeemCollateral,
}

export function handleRedemption(event: Redemption): void {
  const feeAmountETH = event.params._ETHFee;
  const feeAmountUSD = bigIntToBigDecimal(feeAmountETH).times(
    getCurrentETHPrice()
  );
  addProtocolSideRevenue(event, feeAmountUSD);
}

/**
 * Emitted at end of batch liquidation flow, containing aggregate data from all liquidations
 *
 * @param event Liquidation event
 */
export function handleLiquidation(event: Liquidation): void {
  // Total amount of ETH from all (n) troves liquidated in current transaction
  const amountLiquidatedETH = event.params._liquidatedColl;
  const amountLiquidatedUSD = bigIntToBigDecimal(amountLiquidatedETH).times(
    getCurrentETHPrice()
  );
  const profitUSD = bigIntToBigDecimal(event.params._collGasCompensation)
    .times(getCurrentETHPrice())
    .plus(bigIntToBigDecimal(event.params._LUSDGasCompensation));
  createLiquidate(
    event,
    amountLiquidatedETH,
    amountLiquidatedUSD,
    profitUSD,
    event.transaction.from
  );
  const supplySideRevenueUSD = amountLiquidatedUSD.minus(profitUSD);
  addSupplySideRevenue(event, supplySideRevenueUSD);
  addProtocolSideRevenue(event, profitUSD);
}

/**
 * Emitted when a trove was updated because of a TroveManagerOperation operation
 *
 * @param event TroveUpdated event
 */
export function handleTroveUpdated(event: TroveUpdated): void {
  const trove = getOrCreateTrove(event.params._borrower);
  const operation = event.params._operation as TroveManagerOperation;
  switch (operation) {
    case TroveManagerOperation.applyPendingRewards:
      applyPendingRewards(event, trove);
      break;
    case TroveManagerOperation.redeemCollateral:
      redeemCollateral(event, trove);
      break;
  }
  trove.collateral = event.params._coll;
  trove.debt = event.params._debt;
  trove.save();
}

// Treat applyPendingRewards as deposit + borrow
function applyPendingRewards(event: TroveUpdated, trove: _Trove): void {
  const borrower = event.params._borrower;
  const newCollateral = event.params._coll;
  const newDebt = event.params._debt;

  const collateralRewardETH = newCollateral.minus(trove.collateral);
  const collateralRewardUSD = bigIntToBigDecimal(collateralRewardETH).times(
    getCurrentETHPrice()
  );
  createDeposit(event, collateralRewardETH, collateralRewardUSD, borrower);
  const borrowAmountLUSD = newDebt.minus(trove.debt);
  const borrowAmountUSD = bigIntToBigDecimal(borrowAmountLUSD);
  createBorrow(event, borrowAmountLUSD, borrowAmountUSD, borrower);
}

// Treat redeemCollateral as repay + withdraw
function redeemCollateral(event: TroveUpdated, trove: _Trove): void {
  const newCollateral = event.params._coll;
  const newDebt = event.params._debt;

  const repayAmountLUSD = trove.debt.minus(newDebt);
  const repayAmountUSD = bigIntToBigDecimal(repayAmountLUSD);
  createRepay(event, repayAmountLUSD, repayAmountUSD, event.transaction.from);

  let withdrawAmountETH = trove.collateral.minus(newCollateral);
  // If trove was closed, then extra collateral is sent to CollSurplusPool to be withdrawn by trove owner
  if (trove.collateral.equals(BIGINT_ZERO)) {
    withdrawAmountETH = withdrawAmountETH.minus(trove.collateralSurplusChange);
    trove.collateralSurplusChange = BIGINT_ZERO;
  }
  const withdrawAmountUSD = bigIntToBigDecimal(withdrawAmountETH).times(
    getCurrentETHPrice()
  );
  createWithdraw(
    event,
    withdrawAmountETH,
    withdrawAmountUSD,
    event.transaction.from
  );
}
