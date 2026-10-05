import type { AccountRecord } from "../store/account-store.js";
import type { EmailFull, EmailProvider } from "../providers/types.js";
import { draftBodiesEquivalent } from "./draft-html.js";

const EDIT_DRAFT_VERIFY_DELAYS_MS = [250, 1000, 2000] as const;

export interface BodyEditExpectation {
  expectedBody: string;
}


export function bodyEditPersisted(
  actualBody: string,
  expectation: BodyEditExpectation,
): boolean {
  return draftBodiesEquivalent(actualBody, expectation.expectedBody);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function readDraftWithVerifiedBody(
  provider: EmailProvider,
  account: AccountRecord,
  id: string,
  expectation: BodyEditExpectation,
): Promise<EmailFull | undefined> {
  let draft = await provider.readEmail(account, id);
  for (const delayMs of EDIT_DRAFT_VERIFY_DELAYS_MS) {
    const body = draft.bodyHtml ?? draft.bodyText ?? "";
    if (bodyEditPersisted(body, expectation)) return draft;
    await delay(delayMs);
    draft = await provider.readEmail(account, id);
  }

  const body = draft.bodyHtml ?? draft.bodyText ?? "";
  return bodyEditPersisted(body, expectation) ? draft : undefined;
}
