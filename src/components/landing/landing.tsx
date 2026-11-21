"use client";
import { signInAnonymously } from "firebase/auth";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { AuthPanel, type AuthMode } from "@/components/auth/auth-panel";
import { useAuth } from "@/components/auth/auth-provider";
import { authErrorMessage } from "@/lib/firebase/auth-errors";
import { firebaseAuth } from "@/lib/firebase/client";

type TrySource = "nav" | "hero" | "closing";

export function Landing() {
  const { user } = useAuth();
  const router = useRouter();
  const [mode, setMode] = useState<AuthMode>("signup");
  const [trying, setTrying] = useState(false);
  const [tryError, setTryError] = useState<{
    source: TrySource;
    message: string;
  } | null>(null);
  // While "Try the Editor" is running it does its own navigation to the blank
  // project, so the redirect below must not send the user to their saved draft.
  const tryingRef = useRef(false);

  // A returning account, or a successful sign-in from the panel, opens the
  // editor. Guests stay on the landing page so they can come back to it.
  useEffect(() => {
    if (user && !user.isAnonymous && !tryingRef.current) {
      router.replace("/dashboard");
    }
  }, [user, router]);

  async function tryEditor(source: TrySource) {
    if (tryingRef.current) return;
    tryingRef.current = true;
    setTrying(true);
    setTryError(null);
    try {
      // Wait for the saved session to load, and reuse it if there is one.
      const auth = firebaseAuth();
      await auth.authStateReady();
      if (!auth.currentUser) await signInAnonymously(auth);
      router.push("/editor?new");
    } catch (caught) {
      tryingRef.current = false;
      setTrying(false);
      const message = authErrorMessage(caught);
      if (message) setTryError({ source, message });
    }
  }

  const tryLabel = trying ? "Opening…" : "Try the Editor";
  const tryErrorFor = (sources: TrySource[]) =>
    tryError && sources.includes(tryError.source) ? (
      <p className="try-error" role="alert">
        {tryError.message}
      </p>
    ) : null;

  return (
    <div className="landing">
      <nav className="landing-nav" aria-label="Main">
        <a className="brand" href="#top">
          <span className="brand-icon">d.</span> DraftBranch
        </a>
        <div className="landing-links">
          <a className="nav-section" href="#features">
            Features
          </a>
          <a className="nav-section" href="#how-it-works">
            How it works
          </a>
          <a className="nav-section" href="#faq">
            FAQ
          </a>
          <a href="#account" onClick={() => setMode("signin")}>
            Sign in
          </a>
          <button
            type="button"
            className="nav-cta"
            disabled={trying}
            onClick={() => tryEditor("nav")}
          >
            {tryLabel}
          </button>
        </div>
      </nav>

      <main id="top">
        <section className="hero">
          <div className="hero-grid">
            <div className="hero-copy">
              <div className="hero-statements">
                <p className="hero-presenter">
                  J Nicks Productions proudly presents...
                </p>
                <h1 className="hero-title">DraftBranch</h1>

                <h2>
                  <em>Industry-standard</em> screenwriting software with{" "}
                  <em>flexible, powerful</em> version control.
                </h2>
                {/* <h1 className="hero-statement">
                  Industry-standard screenwriting software.
                </h1>
                <p className="hero-statement">Powerful version control.</p>
                <p className="hero-statement">Completely free.</p> */}
              </div>
              <p className="hero-lede">
                A clean, properly formatted screenplay editor, built so writing
                partners can try alternate versions, review each other&apos;s
                changes, and keep the best of both.
              </p>
              <button
                type="button"
                className="hero-cta"
                disabled={trying}
                onClick={() => tryEditor("hero")}
              >
                {tryLabel}
              </button>
              {tryErrorFor(["nav", "hero"])}
              <p className="hero-note">
                Test it out first before wasting ten seconds and zero dollars on
                making an account.
              </p>
            </div>
            <div id="account" className="hero-auth">
              <AuthPanel mode={mode} onModeChange={setMode} />
            </div>
          </div>
          <EditorMock />
        </section>

        <section id="vision" className="vision">
          <div className="eyebrow">The Big Idea</div>
          <h2>
            Why <em>DraftBranch</em> exists
          </h2>
          <p>
            Version control is essential to both engineers and screenwriters:
            both need to preserve their work, explore alternatives, collaborate,
            and understand how a project evolved. Engineers use Git - a
            reliable, open-source tool to manage changes without losing earlier
            work or overwriting someone else’s contributions. Screenwriters face
            many of the same challenges, but often manage them through numbered
            files, emailed drafts, and manually reconciled notes.
            <br />
            <br />
            We dropped the ball on this one.
            <br />
            <br />
            This platform brings Git’s infrastructure into a writing environment
            designed for scripts, giving writers the freedom to try a different
            ending, develop scenes in parallel, and bring the best ideas
            together while keeping a clear history of every revision.
          </p>
        </section>

        <section id="features" className="features">
          <h2>
            Everything a draft needs, <em>nothing it doesn&apos;t</em>
          </h2>
          <div className="feature-grid">
            <Feature
              icon={<PageIcon />}
              tone="sage"
              title="Industry-standard pages"
              items={[
                "US Letter, 12 pt Courier",
                "Standard element indents",
                "Fountain, JSON, and PDF export",
              ]}
            />
            <Feature
              icon={<KeyIcon />}
              tone="sand"
              title="Keyboard-first writing"
              items={[
                "Enter moves to the next element",
                "Tab cycles element types",
                "Saves as you type",
              ]}
            />
            <Feature
              icon={<BranchIcon />}
              tone="slate"
              title="Version control for writers"
              soon
              items={[
                "Alternate drafts on branches",
                "Named revisions and history",
                "Reviewed, screenplay-aware merges",
              ]}
            />
          </div>
        </section>

        <section id="how-it-works" className="journey">
          <h2>
            From <em>first pages</em> to <em>final merge</em>
          </h2>
          <ol className="steps">
            <Step
              title="Write"
              text="Scene headings, action, characters, and dialogue, formatted the moment you type them."
              visual={<WriteVisual />}
            />
            <Step
              title="Branch"
              soon
              text="Try the bold version on its own branch without touching the main draft."
              visual={<BranchVisual />}
            />
            <Step
              title="Review"
              soon
              text="Your writing partner sees exactly what changed, scene by scene, and leaves notes in place."
              visual={<ReviewVisual />}
            />
            <Step
              title="Merge"
              soon
              text="Bring the best of both drafts together. Overlapping edits are resolved side by side, never lost."
              visual={<MergeVisual />}
            />
          </ol>
        </section>

        <section id="faq" className="faq">
          <div className="faq-intro">
            <div className="eyebrow">FAQ</div>
            <h2>Frequently asked questions</h2>
            <p>
              Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do
              eiusmod tempor incididunt ut labore.
            </p>
          </div>
          <div className="faq-list">
            {FAQS.map((faq, index) => (
              <details key={faq.question} open={index === 0}>
                <summary>{faq.question}</summary>
                <p>{faq.answer}</p>
              </details>
            ))}
          </div>
        </section>

        <section className="closing">
          <h2>Your next draft starts here.</h2>
          <button
            type="button"
            className="hero-cta"
            disabled={trying}
            onClick={() => tryEditor("closing")}
          >
            {tryLabel}
          </button>
          {tryErrorFor(["closing"])}
        </section>
      </main>

      <div className="landing-footer">
        <span className="brand">
          <span className="brand-icon">d.</span> DraftBranch
        </span>
        <span>A quiet writing room for screenwriters.</span>
      </div>
    </div>
  );
}

// Placeholder copy until real questions and answers are written.
const FAQS = [
  {
    question: "Lorem ipsum dolor sit amet, consectetur adipiscing?",
    answer:
      "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Integer posuere erat a ante venenatis dapibus. Donec ullamcorper nulla non metus auctor fringilla.",
  },
  {
    question: "Sed ut perspiciatis unde omnis iste natus error?",
    answer:
      "Sed ut perspiciatis unde omnis iste natus error sit voluptatem accusantium doloremque laudantium, totam rem aperiam, eaque ipsa quae ab illo inventore veritatis.",
  },
  {
    question: "Nemo enim ipsam voluptatem quia voluptas sit?",
    answer:
      "Nemo enim ipsam voluptatem quia voluptas sit aspernatur aut odit aut fugit, sed quia consequuntur magni dolores eos qui ratione voluptatem sequi nesciunt.",
  },
  {
    question: "Ut enim ad minima veniam, quis nostrum?",
    answer:
      "Ut enim ad minima veniam, quis nostrum exercitationem ullam corporis suscipit laboriosam, nisi ut aliquid ex ea commodi consequatur.",
  },
  {
    question: "Quis autem vel eum iure reprehenderit?",
    answer:
      "Quis autem vel eum iure reprehenderit qui in ea voluptate velit esse quam nihil molestiae consequatur, vel illum qui dolorem eum fugiat quo voluptas nulla pariatur.",
  },
  {
    question: "At vero eos et accusamus et iusto odio?",
    answer:
      "At vero eos et accusamus et iusto odio dignissimos ducimus qui blanditiis praesentium voluptatum deleniti atque corrupti quos dolores et quas molestias.",
  },
];

function Feature({
  icon,
  tone,
  title,
  items,
  soon,
}: {
  icon: React.ReactNode;
  tone: "sage" | "sand" | "slate";
  title: string;
  items: string[];
  soon?: boolean;
}) {
  return (
    <div className="feature">
      <span className={`feature-icon ${tone}`}>{icon}</span>
      <h3>
        {title}
        {soon && <span className="soon">Soon</span>}
      </h3>
      <ul>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function Step({
  title,
  text,
  visual,
  soon,
}: {
  title: string;
  text: string;
  visual: React.ReactNode;
  soon?: boolean;
}) {
  return (
    <li className="step">
      <div className="step-copy">
        <h3>
          {title}
          {soon && <span className="soon">Soon</span>}
        </h3>
        <p>{text}</p>
      </div>
      <div className="step-visual" aria-hidden="true">
        {visual}
      </div>
    </li>
  );
}

/** Decorative preview of the editor, built from markup rather than an image. */
function EditorMock() {
  return (
    <div className="mock-wrap" aria-hidden="true">
      <div className="mock">
        <div className="mock-bar">
          <i />
          <i />
          <i />
          <span>An Elephant Never Forgives / Screenplay</span>
        </div>
        <div className="mock-body">
          <div className="mock-side">
            <b>SCENE OUTLINE</b>
            <span className="on">01 EXT. COASTAL ROAD - DUSK</span>
            <span>02 INT. STATION WAGON</span>
            <span>03 EXT. LIGHTHOUSE - NIGHT</span>
          </div>
          <div className="mock-desk">
            <div className="mock-page">
              <p>EXT. COASTAL ROAD - DUSK</p>
              <p>
                The last of the daylight hangs over the water. A faded blue
                station wagon hugs the cliffs.
              </p>
              <p className="c">BEN</p>
              <p className="d">
                Is any of this real? What if we exist only in this one tiny
                interaction, as a lazy showcase of functionality?
              </p>
              <p>A beat.</p>
              <p className="c">ELLA</p>
              <p className="p">(concerned)</p>
              <p className="d">Have you been drinking again?</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function WriteVisual() {
  return (
    <div className="mini-page">
      <p>INT. CEMETERY - DAY</p>
      <p className="c">CLOWN</p>
      <p className="d">
        Okay I'm charging double my usual rate guys... I don't like this at all.
        <span className="caret" />
      </p>
    </div>
  );
}
function BranchVisual() {
  return (
    <svg viewBox="0 0 260 120" className="graph">
      <path className="main" d="M10 80 H250" />
      <path className="alt" d="M70 80 C 100 80, 100 30, 140 30 H230" />
      <circle cx="40" cy="80" r="7" />
      <circle cx="110" cy="80" r="7" />
      <circle cx="190" cy="80" r="7" />
      <circle className="alt-dot" cx="160" cy="30" r="7" />
      <circle className="alt-dot" cx="215" cy="30" r="7" />
      <text x="10" y="108">
        main draft
      </text>
      <text x="150" y="14">
        ending-b
      </text>
    </svg>
  );
}
function ReviewVisual() {
  return (
    <div className="diff">
      <p className="ctx">O&apos;HARA</p>
      <p className="unchanged">
        Rhett, if you go, where shall I go? What shall I do?
      </p>
      <p className="ctx">BUTLER</p>
      <p className="del">− Do I look like I give a shit?</p>
      <p className="add">+ Frankly, my dear, I don't give a damn.</p>
      <p className="note">Ben: Still savage, but classy. Love it.</p>
    </div>
  );
}
function MergeVisual() {
  return (
    <svg viewBox="0 0 260 120" className="graph">
      <path className="main" d="M10 80 H250" />
      <path
        className="alt"
        d="M40 80 C 70 80, 70 30, 100 30 H150 C 190 30, 190 80, 220 80"
      />
      <circle cx="40" cy="80" r="7" />
      <circle cx="130" cy="80" r="7" />
      <circle className="alt-dot" cx="120" cy="30" r="7" />
      <circle className="merge-dot" cx="220" cy="80" r="9" />
      <text x="186" y="108">
        merged
      </text>
    </svg>
  );
}

function PageIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 3h8l4 4v14H6z M14 3v4h4 M9 12h6 M9 15h6 M9 18h4" />
    </svg>
  );
}
function KeyIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 7h18v10H3z M6 10h1 M9 10h1 M12 10h1 M15 10h1 M18 10h0.5 M7 14h10" />
    </svg>
  );
}
function BranchIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 7v10 M18 8c0 5-12 3-12 8" />
      <circle cx="6" cy="5" r="2" />
      <circle cx="18" cy="6" r="2" />
      <circle cx="6" cy="19" r="2" />
    </svg>
  );
}
