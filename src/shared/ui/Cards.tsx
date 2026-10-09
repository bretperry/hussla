/*
  Contact and review cards: the same pieces on the job page and the company page.
  In the app: contacts with email, call and LinkedIn links; one review per source with its pros and cons.
  Used by: src/features/jobs/JobPage.tsx, src/features/companies/CompanyPage.tsx.
  Uses: Markdown for agent-written text; only http(s), mailto and tel links are ever made.
*/
import type { Contact, Review } from "../api";
import { dialable, firstEmail, firstPhone, formatWhen } from "../lib/format";
import { MarkdownInline, isSafeLink } from "./Markdown";
import { Tag } from "./Feedback";

export const ContactCard = ({ contact, extra }: { contact: Contact; extra?: string }) => {
  const email = firstEmail(contact.email ?? "");
  const phone = firstPhone(contact.phone ?? "");
  const linkedin = contact.linkedin ?? "";
  return (
    <div className="flex flex-col gap-1 border border-hairline p-4">
      {contact.priority === undefined || contact.priority === "" ? null : <span className="kicker text-muted">{contact.priority}</span>}
      <span className="font-display text-row font-bold"><MarkdownInline source={contact.name} /></span>
      {contact.role === undefined || contact.role === "" ? null : <span className="text-muted"><MarkdownInline source={contact.role} /></span>}
      {extra === undefined ? null : <span className="text-small text-muted">{extra}</span>}
      {email === "" ? null : (
        <span>
          ✉ <a href={`mailto:${email}`} className="underline">{email}</a>{" "}
          {contact.emailStatus === "verified" ? <Tag>Verified</Tag> : null}
          {contact.emailStatus === "inferred" ? <Tag urgent>Inferred</Tag> : null}
        </span>
      )}
      {phone === "" ? null : (
        <span>☎ <a href={`tel:${dialable(phone)}`} className="underline">{phone}</a></span>
      )}
      {linkedin !== "" && isSafeLink(linkedin) ? (
        <a href={linkedin} target="_blank" rel="noopener noreferrer" className="underline">LinkedIn ↗</a>
      ) : null}
      {contact.source === undefined || contact.source === "" ? null : <span className="text-small text-muted"><MarkdownInline source={contact.source} /></span>}
      {contact.notes === undefined || contact.notes === "" ? null : <span className="text-small"><MarkdownInline source={contact.notes} /></span>}
    </div>
  );
};

export const ReviewCard = ({ review }: { review: Review }) => (
  <div className="flex flex-col gap-2 border border-hairline p-4">
    <div className="flex flex-wrap items-baseline gap-2">
      <span className="font-display text-row font-bold">{review.source}</span>
      {review.rating === null ? (
        <span className="text-small text-muted">no rating</span>
      ) : (
        <span>
          <span className="font-display text-title font-black">{review.rating}</span>
          <span className="text-muted"> / {review.ratingScale}</span>
        </span>
      )}
      {review.reviewCount === null ? null : <span className="text-small text-muted">{review.reviewCount} reviews</span>}
    </div>
    {review.summary === "" ? null : <p><MarkdownInline source={review.summary} /></p>}
    {review.pros.length + review.cons.length === 0 ? null : (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <span className="kicker">Pros</span>
          <ul className="ml-4 list-disc">{review.pros.map((item) => <li key={item}>{item}</li>)}</ul>
        </div>
        <div>
          <span className="kicker">Cons</span>
          <ul className="ml-4 list-disc">{review.cons.map((item) => <li key={item}>{item}</li>)}</ul>
        </div>
      </div>
    )}
    {review.url !== "" && isSafeLink(review.url) ? (
      <span className="text-small">
        <a href={review.url} target="_blank" rel="noopener noreferrer" className="underline">Read on {review.source} ↗</a>{" "}
        <span className="text-muted">{formatWhen(review.fetchedAt)}</span>
      </span>
    ) : null}
  </div>
);
