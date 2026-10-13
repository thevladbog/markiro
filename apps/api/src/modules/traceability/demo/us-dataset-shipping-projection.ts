import { assertBoundedSyntheticJson } from "./us-demo-journal-contract.js";
import {
  parseUsDatasetReceivingResult,
  type UsDatasetReceivingResult,
} from "./us-dataset-receiving-contract.js";
import {
  parseUsDatasetTransformationResult,
  type UsDatasetTransformationResult,
} from "./us-dataset-transformation-contract.js";
import {
  parseUsDatasetShippingResult,
  type UsDatasetShippingResult,
} from "./us-dataset-shipping-contract.js";

export type UsDatasetVerifiedOrigin = Readonly<{
  receiving: UsDatasetReceivingResult;
  transformation: UsDatasetTransformationResult;
}>;
export type UsDatasetShippingProjection = UsDatasetVerifiedOrigin &
  Readonly<{ shipping: UsDatasetShippingResult }>;

/** Internal value ownership only. Calling this parser never establishes native proof. */
export function ownUsDatasetShippingProjection(
  verified: UsDatasetShippingProjection,
): UsDatasetShippingProjection {
  const owned = Object.freeze({
    receiving: parseUsDatasetReceivingResult(verified.receiving),
    transformation: parseUsDatasetTransformationResult(verified.transformation),
    shipping: parseUsDatasetShippingResult(verified.shipping),
  });
  assertBoundedSyntheticJson(owned);
  return owned;
}
