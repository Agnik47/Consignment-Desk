/**
 * Seller-facing "create a listing" flow: takes the seller's chosen min/max
 * price, triggers the Jetson to capture a fresh photo right now, then spins
 * up a brand-new auction room — its own deployed contract instance
 * (scripts/deployRoom.ts, one app per room, see contract.ts's module comment)
 * and its own QR code (built client-side from the returned roomId).
 *
 * maxPrice becomes the hidden target bidders are scored against (committed
 * on-chain, never returned by this call — see rooms.ts's getPublicView).
 * minPrice becomes a public floor. Neither is derived from the Jetson grade
 * card; the grade only informs the hint text an agent can pay to unlock.
 *
 * Jetson /capture contract (confirmed against the real device, not guessed):
 *   POST <JETSON_CAPTURE_URL>?item_id=<LOT-NNN>
 *   -> 200 { image_url: string, grade_card: { category, identified_as, condition, grader_confidence } }
 *   Synchronous — the Jetson also writes this to its own Supabase `items` row
 *   under the same id, independent of this response, so no polling is needed.
 */
import crypto from "node:crypto";
import { deployRoom } from "../../scripts/deployRoom.js";
import { createRoom, productFromCapture, getPublicView, fromCents } from "./rooms.js";
import type { CaptureResult, PublicProduct } from "./rooms.js";
import { registerRoomChainConfig } from "./contract.js";

export class ListingError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface CreateListingResult {
  roomId: string;
  product: PublicProduct;
}

export interface CreateListingInput {
  /** Public floor — shown to bidders. */
  minPrice: number;
  /** The hidden target bidders' guesses are scored against. Never leaves the API before reveal. */
  maxPrice: number;
}

/**
 * Business-rule validation for the seller's chosen price range (spec §7):
 * both positive, min <= max. Type-shape checking (is it even a number) is the
 * HTTP route's job (index.ts) — this only checks the range makes sense.
 */
export function assertValidPriceRange(minPrice: number, maxPrice: number): void {
  if (!Number.isFinite(minPrice) || minPrice <= 0) {
    throw new ListingError("INVALID_PRICE_RANGE", "Minimum price must be a positive number.");
  }
  if (!Number.isFinite(maxPrice) || maxPrice <= 0) {
    throw new ListingError("INVALID_PRICE_RANGE", "Maximum price must be a positive number.");
  }
  if (minPrice > maxPrice) {
    throw new ListingError("INVALID_PRICE_RANGE", "Minimum price cannot exceed maximum price.");
  }
}

// One physical Jetson, one "List" button — a single in-progress flag is
// enough to stop two overlapping captures, mirroring entry.ts's `pending` set.
let captureInProgress = false;

let lotCounter = 0;
function nextItemId(): string {
  lotCounter += 1;
  return `LOT-${String(lotCounter).padStart(3, "0")}`;
}

interface CaptureResponse {
  image_url: string;
  grade_card: {
    category: string | null;
    identified_as: string | null;
    condition: unknown;
    grader_confidence: number | null;
  };
}

export async function createListing(input: CreateListingInput): Promise<CreateListingResult> {
  assertValidPriceRange(input.minPrice, input.maxPrice);

  if (captureInProgress) {
    throw new ListingError("CAPTURE_IN_PROGRESS", "A capture is already in progress. Please wait for it to finish.");
  }
  captureInProgress = true;

  try {
    const captureUrl = process.env.JETSON_CAPTURE_URL;
    if (!captureUrl) {
      throw new ListingError("JETSON_NOT_CONFIGURED", "JETSON_CAPTURE_URL is not set — see .env.example.");
    }

    const itemId = nextItemId();
    const timeoutMs = Number(process.env.JETSON_CAPTURE_TIMEOUT_MS ?? 30_000);

    let capture: CaptureResponse;
    try {
      const url = `${captureUrl}${captureUrl.includes("?") ? "&" : "?"}item_id=${encodeURIComponent(itemId)}`;
      const apiKey = process.env.JETSON_CAPTURE_API_KEY;
      const res = await fetch(url, {
        method: "POST",
        headers: apiKey ? { "X-API-Key": apiKey } : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`Jetson returned ${res.status}`);
      capture = (await res.json()) as CaptureResponse;
    } catch (err) {
      throw new ListingError(
        "CAPTURE_FAILED",
        `Could not capture a photo: ${err instanceof Error ? err.message : "unknown error"}`,
      );
    }

    const gradeInputs: CaptureResult = {
      imageUrl: capture.image_url ?? null,
      category: capture.grade_card?.category ?? null,
      identifiedAs: capture.grade_card?.identified_as ?? null,
      condition: capture.grade_card?.condition ?? null,
      graderConfidence: capture.grade_card?.grader_confidence ?? null,
    };

    let deployed;
    try {
      deployed = await deployRoom({
        targetDollars: input.maxPrice,
        productName: gradeInputs.identifiedAs ?? "Untitled item",
      });
    } catch (err) {
      throw new ListingError(
        "DEPLOY_FAILED",
        `Could not deploy the room's contract: ${err instanceof Error ? err.message : "unknown error"}`,
      );
    }

    const roomId = crypto.randomUUID();
    const product = productFromCapture(
      gradeInputs,
      roomId,
      fromCents(deployed.targetCents),
      deployed.targetNonce,
      input.minPrice,
    );
    createRoom(roomId, product);
    registerRoomChainConfig(roomId, {
      appId: deployed.appId,
      productAssetId: deployed.productAssetId,
      targetCents: deployed.targetCents,
      targetNonce: deployed.targetNonce,
      bidStakeMicroUsdc: deployed.bidStakeMicroUsdc,
    });

    console.log(`[listings] room=${roomId} item=${itemId} product="${product.name}" app=${deployed.appId}`);
    return { roomId, product: getPublicView(roomId).product };
  } finally {
    captureInProgress = false;
  }
}
