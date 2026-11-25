"use client";
import { useState, type FormEvent } from "react";
import {
  CONTACT_EMAIL,
  contactErrorMessage,
  sendContactMessage,
} from "@/lib/contact";

type Status = "idle" | "sending" | "sent";

export function ContactSection() {
  const [form, setForm] = useState({
    name: "",
    email: "",
    subject: "",
    message: "",
    website: "",
  });
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const update = (key: keyof typeof form) => (value: string) =>
    setForm((current) => ({ ...current, [key]: value }));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (status === "sending") return;
    setStatus("sending");
    setError(null);
    try {
      await sendContactMessage(form);
      setStatus("sent");
      setForm({ name: "", email: "", subject: "", message: "", website: "" });
    } catch (failure) {
      setStatus("idle");
      setError(contactErrorMessage(failure));
    }
  }

  return (
    <section id="contact" className="contact">
      <div className="contact-intro">
        <div className="eyebrow">Contact</div>
        <h2>
          Say <em>hello</em>
        </h2>
        <p>
          Feedback, feature ideas, bug reports, or anything else:
          send a note and I’ll get back to you.
        </p>
        <p className="contact-direct">
          Prefer email? <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
        </p>
      </div>

      <div className="contact-card">
        {status === "sent" ? (
          <div className="contact-sent" role="status">
            <span className="contact-sent-mark" aria-hidden="true">
              ✓
            </span>
            <h3>Message sent</h3>
            <p>Thanks for reaching out. I’ll reply to the email you gave.</p>
            <button
              type="button"
              className="contact-again"
              onClick={() => setStatus("idle")}
            >
              Send another message
            </button>
          </div>
        ) : (
          <form onSubmit={submit} noValidate={false}>
            <div className="contact-row">
              <label>
                Name
                <input
                  name="name"
                  autoComplete="name"
                  placeholder="S. Curry"
                  required
                  maxLength={100}
                  value={form.name}
                  onChange={(e) => update("name")(e.target.value)}
                />
              </label>
              <label>
                Email
                <input
                  name="email"
                  type="email"
                  autoComplete="email"
                  placeholder="steph@dontcurrybehappy.com"
                  required
                  maxLength={254}
                  value={form.email}
                  onChange={(e) => update("email")(e.target.value)}
                />
              </label>
            </div>
            <label>
              Subject
              <input
                name="subject"
                required
                maxLength={150}
                placeholder="Like Steph"
                value={form.subject}
                onChange={(e) => update("subject")(e.target.value)}
              />
            </label>
            <label>
              Message
              <textarea
                name="message"
                required
                rows={6}
                maxLength={5000}
                placeholder="Hey man, love the site! I'm writing a movie where a kid wishes to play ball like me. I like your style, was wondering if you wanted to collab. I can't afford to pay you, but you'd get equity, Hit me back, we'll talk details."
                value={form.message}
                onChange={(e) => update("message")(e.target.value)}
              />
            </label>
            {/* Bots fill every field; people never see this one. */}
            <label className="contact-trap" aria-hidden="true">
              Website
              <input
                name="website"
                tabIndex={-1}
                autoComplete="off"
                value={form.website}
                onChange={(e) => update("website")(e.target.value)}
              />
            </label>
            {error && (
              <p className="contact-error" role="alert">
                {error}
              </p>
            )}
            <button
              type="submit"
              className="hero-cta contact-submit"
              disabled={status === "sending"}
            >
              {status === "sending" ? "Sending…" : "Send message"}
            </button>
          </form>
        )}
      </div>
    </section>
  );
}
