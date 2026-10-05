import { z } from "zod";

import { emailAddrSchema } from "./shared.js";

export const sendEmailSchema = z.object({
  account: z.string().email(),
  to: z.array(emailAddrSchema).min(1),
  cc: z.array(emailAddrSchema).optional(),
  bcc: z.array(emailAddrSchema).optional(),
  subject: z.string(),
  body: z.string().describe(
    "Email content in Markdown only; raw HTML is not supported. Use a blank line between paragraphs.",
  ),
  include_signature: z
    .boolean()
    .describe(
      "Whether to append the account's saved HTML signature to the email. " +
        "If true, don't include a signature in the body param to avoid double signature. " +
        "Returns an error if true but no signature is configured for this account.",
    ),
  inReplyTo: z
    .preprocess(
      (value) => (value === "false" ? false : value),
      z.union([z.string(), z.literal(false)]),
    )
    .describe(
      "Message ID to reply to. When set, sends as a threaded reply " +
        "which includes the quoted thread history automatically. " +
        "Set to `false` for a new email (not a reply).",
    ),
  replyAll: z
    .boolean()
    .default(false)
    .optional()
    .describe(
      "When true and `inReplyTo` is set, reply to all recipients " +
        "instead of just the sender.",
    ),
  forwardMessageId: z
    .string()
    .optional()
    .describe(
      "Message ID to forward. When set, sends as a forward of the " +
        "specified message, preserving the original content. " +
        "Mutually exclusive with `inReplyTo`.",
    ),
  attachments: z
    .array(
      z.object({
        filePath: z.string().min(1).describe("Absolute path to a local file"),
        name: z
          .string()
          .optional()
          .describe("Attachment filename. Defaults to the file's basename."),
      }),
    )
    .optional()
    .describe(
      "File attachments to include. The server reads the files from " +
        "disk and base64-encodes them automatically.",
    ),
});

export type SendEmailArgs = z.infer<typeof sendEmailSchema>;

export const editDraftSchema = z.object({
  account: z.string().email(),
  id: z.string().min(1).describe("Draft message ID to edit"),
  to: z.array(emailAddrSchema).optional(),
  cc: z.array(emailAddrSchema).optional(),
  bcc: z.array(emailAddrSchema).optional(),
  subject: z.string().optional(),
  old_text: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Exact current Markdown word, phrase or block to replace in the draft body. " +
        "Copy from draftMarkdown or a complete current read_email Markdown body, never a truncated preview. " +
        "Must match exactly once; unselected HTML is preserved. Unsafe structural selections are rejected.",
    ),
  new_text: z
    .string()
    .optional()
    .describe(
      "Replacement content for `old_text` in Markdown only; raw HTML is not supported. " +
        "Use a blank line between paragraphs. The replacement is converted to HTML " +
        "with optional `include_signature`, then inserted where `old_text` matched.",
    ),
  body: z
    .string()
    .optional()
    .describe(
      "Deprecated alias for `new_text`, in Markdown only; raw HTML is not supported. " +
        "Use a blank line between paragraphs. Body-only full replacement is " +
        "not supported; provide `old_text` with this field.",
    ),
  include_signature: z
    .boolean()
    .optional()
    .describe(
      "Whether to append the account's saved HTML signature to the " +
        "replacement section. If true, don't include a signature in " +
        "`new_text`/`body`. Only meaningful when replacement content is provided. " +
        "Returns an error if true but no signature is configured for this account.",
    ),
  new_attachments: z
    .array(
      z.object({
        filePath: z.string().min(1).describe("Absolute path to a local file"),
        name: z
          .string()
          .optional()
          .describe("Attachment filename. Defaults to the file's basename."),
      }),
    )
    .optional()
    .describe(
      "New file attachments to add to the draft. The server reads " +
        "the files from disk and base64-encodes them automatically.",
    ),
  remove_attachments: z
    .array(z.string().min(1))
    .optional()
    .describe("Attachment IDs to remove from the draft. Get attachment IDs from read_email."),
});

export type EditDraftArgs = z.infer<typeof editDraftSchema>;
