import { getApp, getApps, initializeApp, type FirebaseApp } from "firebase/app";
import { getAuth, type Auth } from "firebase/auth";

/** Web config for the `draftbranch` Firebase project. These values identify the
 * project to the browser SDK and are public by design; access is enforced by
 * Firebase Authentication and security rules, not by keeping this secret.
 */
const firebaseConfig = {
  apiKey: "AIzaSyDqG_tgP-ELrlzLo90gDQIj6mpTXjKSOO8",
  authDomain: "draftbranch.firebaseapp.com",
  projectId: "draftbranch",
  storageBucket: "draftbranch.firebasestorage.app",
  messagingSenderId: "115103534608",
  appId: "1:115103534608:web:8f9e00552620d2ec9ac495",
};

function firebaseApp(): FirebaseApp {
  return getApps().length ? getApp() : initializeApp(firebaseConfig);
}

/** Call from browser code only (effects and event handlers), never during render. */
export function firebaseAuth(): Auth {
  return getAuth(firebaseApp());
}
