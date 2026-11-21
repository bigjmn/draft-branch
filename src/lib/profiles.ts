import { doc, getDoc, serverTimestamp, setDoc } from "firebase/firestore";
import {
  ref,
  uploadBytes,
  getDownloadURL,
  deleteObject,
} from "firebase/storage";
import { firebaseDb, firebaseStorage } from "./firebase/client";
export interface Profile {
  name: string;
  job: string;
  company: string;
  bio: string;
  avatarId: string;
}
export const emptyProfile: Profile = {
  name: "",
  job: "",
  company: "",
  bio: "",
  avatarId: "",
};
export async function loadProfile(uid: string): Promise<Profile | null> {
  const result = await getDoc(doc(firebaseDb(), "profiles", uid));
  return result.exists() ? (result.data() as Profile) : null;
}
export function avatarUrl(uid: string, id: string) {
  return getDownloadURL(ref(firebaseStorage(), `avatars/${uid}/${id}.png`));
}
export function validateProfile(profile: Profile) {
  if (
    !profile.name.trim() ||
    profile.name.length > 100 ||
    profile.job.length > 100 ||
    profile.company.length > 100 ||
    profile.bio.length > 500
  )
    throw new Error(
      "Enter a name (up to 100 characters), job/company (up to 100 each), and bio (up to 500).",
    );
}
export async function prepareAvatar(file: File): Promise<Blob> {
  if (
    !["image/jpeg", "image/png", "image/webp"].includes(file.type) ||
    file.size > 5 * 1024 * 1024
  )
    throw new Error("Choose a JPG, PNG, or WebP image under 5 MiB.");
  const image = await createImageBitmap(file);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 512;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image processing is unavailable.");
    const size = Math.min(image.width, image.height);
    context.drawImage(
      image,
      (image.width - size) / 2,
      (image.height - size) / 2,
      size,
      size,
      0,
      0,
      512,
      512,
    );
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (blob) =>
          blob ? resolve(blob) : reject(new Error("Could not process image.")),
        "image/png",
      ),
    );
  } finally {
    image.close();
  }
}
export async function saveProfile(
  uid: string,
  profile: Profile,
  image: Blob | null,
) {
  validateProfile(profile);
  const next = {
    ...profile,
    name: profile.name.trim(),
    job: profile.job.trim(),
    company: profile.company.trim(),
    bio: profile.bio.trim(),
  };
  const upload = image
    ? ref(firebaseStorage(), `avatars/${uid}/${crypto.randomUUID()}.png`)
    : null;
  if (upload) {
    await uploadBytes(upload, image!, { contentType: "image/png" });
    next.avatarId = upload.name.replace(/\.png$/, "");
  }
  try {
    await setDoc(doc(firebaseDb(), "profiles", uid), {
      ...next,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    if (upload) await deleteObject(upload).catch(() => {});
    throw error;
  }
  return next;
}
