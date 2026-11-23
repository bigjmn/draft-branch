"use client";
import { BetaBadge } from "@/components/ui/beta-badge";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { updateProfile } from "firebase/auth";
import { useAuth } from "@/components/auth/auth-provider";
import { ThemeToggle } from "@/components/theme/theme-provider";
import { TypewriterLoader } from "@/components/ui/typewriter-loader";
import {
  avatarUrl,
  emptyProfile,
  loadProfile,
  prepareAvatar,
  saveProfile,
  type Profile,
} from "@/lib/profiles";
function Avatar({ src }: { src: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  return (
    <div className="profile-avatar">
      {src && !failed ? (
        <img src={src} alt="Profile picture" onError={() => setFailed(true)} />
      ) : (
        <svg
          viewBox="0 0 100 100"
          role="img"
          aria-label="Default profile silhouette"
        >
          <circle cx="50" cy="35" r="18" fill="currentColor" />
          <path d="M16 90c0-24 13-36 34-36s34 12 34 36" fill="currentColor" />
        </svg>
      )}
    </div>
  );
}
export function ProfilePage() {
  const { user, loading } = useAuth();
  const params = useSearchParams();
  const uid = params.get("user") || (user && !user.isAnonymous ? user.uid : "");
  if (loading) return <TypewriterLoader />;
  return (
    <div className="dashboard">
      <nav className="workspace-nav">
        <Link href="/" className="brand">
          DraftBranch <BetaBadge />
        </Link>
        <div className="workspace-account">
          <Link href={user && !user.isAnonymous ? "/dashboard" : "/"}>
            {user && !user.isAnonymous ? "Dashboard" : "Sign in"}
          </Link>
          <ThemeToggle />
        </div>
      </nav>
      {uid ? (
        <ProfileContent
          key={uid}
          uid={uid}
          own={user?.uid === uid && !user.isAnonymous}
        />
      ) : (
        <main className="profile-main">
          <h1>Your profile</h1>
          <p>Sign in with an account to create and manage your profile.</p>
          <Link href="/">Sign in or create an account →</Link>
        </main>
      )}
    </div>
  );
}
function ProfileContent({ uid, own }: { uid: string; own: boolean }) {
  const { user } = useAuth();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [form, setForm] = useState<Profile>(emptyProfile);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [image, setImage] = useState<Blob | null>(null);
  const [photo, setPhoto] = useState("");
  const [preview, setPreview] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  useEffect(() => {
    let active = true;
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(uid)) {
      setError("Profile not found.");
      setLoading(false);
      return;
    }
    loadProfile(uid)
      .then((value) => {
        if (!active) return;
        const initial =
          value ||
          (own ? { ...emptyProfile, name: user?.displayName || "" } : null);
        setProfile(initial);
        setForm(initial || emptyProfile);
      })
      .catch(() => {
        if (active)
          setError("Couldn’t load this profile. Please reload to try again.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [uid, own, user?.displayName]);
  useEffect(() => {
    let active = true;
    setPhoto("");
    if (profile?.avatarId)
      avatarUrl(uid, profile.avatarId)
        .then((url) => {
          if (active) setPhoto(url);
        })
        .catch(() => {});
    return () => {
      active = false;
    };
  }, [uid, profile?.avatarId]);
  useEffect(() => {
    if (!image) {
      setPreview("");
      return;
    }
    const url = URL.createObjectURL(image);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [image]);
  if (loading) return <TypewriterLoader />;
  if (!profile)
    return (
      <main className="profile-main">
        <h1>Profile unavailable</h1>
        <p role="alert">
          {error || "This writer hasn’t created a profile yet."}
        </p>
      </main>
    );
  return (
    <main className="profile-main">
      <section className="profile-card">
        <div className="profile-heading">
          <Avatar
            src={editing ? preview || (form.avatarId ? photo : "") : photo}
          />
          <div>
            <div className="eyebrow">WRITER PROFILE</div>
            <h1>{profile.name || "Your profile"}</h1>
            <p>{[profile.job, profile.company].filter(Boolean).join(" · ")}</p>
          </div>
          {own && !editing && (
            <button
              className="primary-action"
              onClick={() => {
                setForm(profile);
                setImage(null);
                setError("");
                setMessage("");
                setEditing(true);
              }}
            >
              Edit profile
            </button>
          )}
        </div>
        {editing && own ? (
          <form
            className="profile-form"
            onSubmit={async (event) => {
              event.preventDefault();
              if (
                busy ||
                processing ||
                !user ||
                user.uid !== uid ||
                user.isAnonymous
              )
                return;
              setBusy(true);
              setError("");
              setMessage("");
              try {
                const next = await saveProfile(uid, form, image);
                setProfile(next);
                setEditing(false);
                setImage(null);
                setMessage("Profile saved.");
                await updateProfile(user, { displayName: next.name }).catch(
                  () =>
                    setMessage(
                      "Profile saved. Your account display name couldn’t sync; try saving again later.",
                    ),
                );
              } catch (error) {
                setError(
                  error instanceof Error
                    ? error.message
                    : "Couldn’t save your profile. Please try again.",
                );
              } finally {
                setBusy(false);
              }
            }}
          >
            <p className="profile-note">
              Your profile fields and picture are visible to anyone with your
              profile link. Your private projects remain private.
            </p>
            <fieldset disabled={busy || processing}>
              <label>
                Profile picture
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  onChange={async (event) => {
                    const file = event.target.files?.[0];
                    if (!file) return;
                    setProcessing(true);
                    setError("");
                    try {
                      setImage(await prepareAvatar(file));
                    } catch (error) {
                      setError(
                        error instanceof Error
                          ? error.message
                          : "Couldn’t read image.",
                      );
                    } finally {
                      setProcessing(false);
                    }
                  }}
                />
              </label>
              <p className="profile-note">
                JPG, PNG or WebP, up to 5 MiB. Pictures are cropped to a square.
              </p>
              <button
                type="button"
                onClick={() => {
                  setImage(null);
                  setForm({ ...form, avatarId: "" });
                }}
              >
                Use default picture
              </button>
              {(
                [
                  ["name", "Name", 100],
                  ["job", "Job / role", 100],
                  ["company", "Company", 100],
                ] as const
              ).map(([key, label, max]) => (
                <label key={key}>
                  {label}
                  <input
                    required={key === "name"}
                    maxLength={max}
                    value={form[key]}
                    onChange={(event) =>
                      setForm({ ...form, [key]: event.target.value })
                    }
                  />
                </label>
              ))}
              <label>
                Short bio
                <textarea
                  rows={5}
                  maxLength={500}
                  value={form.bio}
                  onChange={(event) =>
                    setForm({ ...form, bio: event.target.value })
                  }
                />
                <span className="profile-note">{form.bio.length}/500</span>
              </label>
              <div className="dialog-actions">
                <button
                  type="button"
                  onClick={() => {
                    setEditing(false);
                    setImage(null);
                    setError("");
                  }}
                >
                  Cancel
                </button>
                <button className="primary-action" type="submit">
                  {busy ? "Saving…" : "Save profile"}
                </button>
              </div>
            </fieldset>
            {processing && <p role="status">Preparing picture…</p>}
          </form>
        ) : (
          <p className="profile-bio">
            {profile.bio ||
              (own
                ? "Tell other writers a little about yourself."
                : "No bio yet.")}
          </p>
        )}
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        {message && <p role="status">{message}</p>}
        {own && (
          <Link
            className="profile-link"
            href={`/profile?user=${encodeURIComponent(uid)}`}
          >
            View shareable profile ↗
          </Link>
        )}
      </section>
      <section className="profile-featured">
        <div className="eyebrow">SELECTED WORK</div>
        <h2>Featured projects</h2>
        <div className="profile-empty">
          <span aria-hidden="true">▤</span>
          <h3>No featured projects yet</h3>
          <p>
            {own
              ? "When public projects become available, you’ll be able to pin your work here."
              : "This writer’s featured projects will appear here."}
          </p>
        </div>
      </section>
    </main>
  );
}
