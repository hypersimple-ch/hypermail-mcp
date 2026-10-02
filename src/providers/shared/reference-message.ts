import type { ParsedMail } from "mailparser";
import type { SendMailOptions } from "nodemailer";
import type { SendInput } from "../types.js";
import { parsedAddresses, parsedMailOptions } from "./draft-mime.js";

export function applyParsedReference(options: SendMailOptions, reference: ParsedMail, input: SendInput, selfEmail: string): void {
  const forward = Boolean(input.forwardMessageId);
  if (!forward) {
    if (!reference.messageId) throw new Error("reference message is missing RFC Message-ID");
    options.inReplyTo = reference.messageId;
    options.references = [...new Set([...(Array.isArray(reference.references) ? reference.references : reference.references ? [reference.references] : []), reference.messageId])];
    if (input.replyAll) {
      const to = [...input.to];
      const cc = [...(input.cc ?? [])];
      const seen = new Set([selfEmail, ...to.map((address) => address.address), ...cc.map((address) => address.address), ...(input.bcc ?? []).map((address) => address.address)].map((address) => address.toLowerCase()));
      for (const [target, inherited] of [[to, [...parsedAddresses(reference.replyTo ?? reference.from), ...parsedAddresses(reference.to)]], [cc, parsedAddresses(reference.cc)]] as const) {
        for (const address of inherited) if (!seen.has(address.address.toLowerCase())) { seen.add(address.address.toLowerCase()); target.push(address); }
      }
      options.to = to.map((address) => ({ ...address, name: address.name ?? "" }));
      options.cc = cc.map((address) => ({ ...address, name: address.name ?? "" }));
    }
  }
  const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const metadata = ["From: " + parsedAddresses(reference.from).map((a) => a.name ? `${a.name} <${a.address}>` : a.address).join(", "), "To: " + parsedAddresses(reference.to).map((a) => a.name ? `${a.name} <${a.address}>` : a.address).join(", "), "Cc: " + parsedAddresses(reference.cc).map((a) => a.name ? `${a.name} <${a.address}>` : a.address).join(", "), "Date: " + (reference.date?.toISOString() ?? ""), "Subject: " + (reference.subject ?? "")];
  const html = reference.html === false || !reference.html ? `<pre>${escape(reference.text ?? "")}</pre>` : reference.html;
  if (options.html !== undefined) {
    options.html = `${options.html}\n\n<div style="line-height:12px"><br></div>\n${forward ? `<div>---------- Forwarded message ---------<br>${metadata.map(escape).join("<br>")}<br>${html}</div>` : `<blockquote>${html}</blockquote>`}`;
  } else {
    options.text = `${options.text ?? ""}\n\n---------- ${forward ? "Forwarded" : "Original"} message ---------\n${forward ? metadata.join("\n") + "\n\n" + (reference.text ?? "") : (reference.text ?? "").replace(/^/gm, "> ")}`;
  }
  const inheritedAttachments = parsedMailOptions(reference).attachments ?? [];
  options.attachments = [...(forward ? inheritedAttachments : inheritedAttachments.filter((attachment) => attachment.cid && html.includes(`cid:${attachment.cid}`) && options.html !== undefined)), ...(options.attachments ?? [])];
}
