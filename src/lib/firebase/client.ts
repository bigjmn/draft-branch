import { getApp, getApps, initializeApp, type FirebaseApp } from "firebase/app";
import { getAuth, connectAuthEmulator, type Auth } from "firebase/auth";
import { getFirestore, connectFirestoreEmulator } from "firebase/firestore";
import { getStorage, connectStorageEmulator } from "firebase/storage";
import { getFunctions, connectFunctionsEmulator } from "firebase/functions";

/** Web config for the `draftbranch` Firebase project. These values identify the
 * project to the browser SDK and are public by design; access is enforced by
 * Firebase Authentication and security rules, not by keeping this secret.
 */
const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: "draftbranch.firebaseapp.com",
  projectId: "draftbranch",
  storageBucket: "draftbranch.firebasestorage.app",
  messagingSenderId: "115103534608",
  appId: "1:115103534608:web:8f9e00552620d2ec9ac495",
};

const emulatorApps = new WeakSet<FirebaseApp>();
function firebaseApp(): FirebaseApp {
  const emulator = process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATORS === "true";
  const app = getApps().length
    ? getApp()
    : initializeApp(
        emulator
          ? {
              ...firebaseConfig,
              apiKey: "demo-api-key",
              projectId: "demo-draftbranch",
              authDomain: "demo-draftbranch.firebaseapp.com",
              storageBucket: "demo-draftbranch.firebasestorage.app",
            }
          : firebaseConfig,
      );
  if (emulator && !emulatorApps.has(app)) {
    emulatorApps.add(app);
    connectAuthEmulator(getAuth(app), "http://127.0.0.1:9099", {
      disableWarnings: true,
    });
    connectFirestoreEmulator(getFirestore(app), "127.0.0.1", 8080);
    connectStorageEmulator(getStorage(app), "127.0.0.1", 9199);
    connectFunctionsEmulator(
      getFunctions(app, "us-central1"),
      "127.0.0.1",
      5001,
    );
  }
  return app;
}

/** Call from browser code only (effects and event handlers), never during render. */
export function firebaseAuth(): Auth {
  return getAuth(firebaseApp());
}

export function firebaseDb() {
  return getFirestore(firebaseApp());
}
export function firebaseStorage() {
  return getStorage(firebaseApp());
}
export function firebaseFunctions() {
  return getFunctions(firebaseApp(), "us-central1");
}
