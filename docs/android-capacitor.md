# Android / iOS wrapper notes (Capacitor)

The web app is a PWA and can be wrapped with [Capacitor](https://capacitorjs.com/) for the Play Store / App Store.
**Read the store policies first:** both stores restrict adult/sexual content and require user-generated-content safeguards (report, block, moderation, a way to contact you, age gating). A random-chat app with adult rooms may not be accepted without changes; get this reviewed before investing in a native release.

```bash
cd frontend
npm i @capacitor/core @capacitor/cli @capacitor/android
npx cap init "Chat Everyday" com.example.chateveryday --web-dir=dist
npm run build && npx cap add android && npx cap sync
```

Set `server.url` / `allowNavigation` in `capacitor.config.ts` only if you serve the SPA remotely; otherwise bundle `dist` and point `VITE_API_URL` / `VITE_SOCKET_URL` at your API origin (and add that origin to `CORS_ORIGINS`; cookies need `COOKIE_SAMESITE=none` + HTTPS for a cross-origin API, or keep a first-party domain).

## Blocking screenshots / screen recording: `FLAG_SECURE`

Browsers cannot prevent screenshots, but an Android WebView app can. In `android/app/src/main/java/.../MainActivity.java`:

```java
import android.os.Bundle;
import android.view.WindowManager;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
  @Override
  public void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    // Black-out screenshots, screen recording and the recent-apps preview for the whole app.
    getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE);
  }
}
```

To protect **only the photo viewer** instead of the whole app, add a tiny Capacitor plugin with `setSecure(boolean)` that sets/clears `FLAG_SECURE` and call it from `SecureImage.jsx` when an image is opened/closed (`Capacitor.isNativePlatform()` guard). On iOS there is no equivalent public flag; you can detect `UIScreen.capturedDidChangeNotification` / `userDidTakeScreenshotNotification` and hide the content or warn the sender.

`FLAG_SECURE` is **not bulletproof** (rooted devices, a second camera, accessibility abuse) and must still be described honestly in the Terms.

## Other native considerations

* Camera/microphone permissions for video (`CAMERA`, `RECORD_AUDIO`); request them just-in-time.
* Push notifications are not implemented (chats are ephemeral); `@capacitor/push-notifications` could notify about room mentions / saved-chat requests.
* Disable WebView debugging and enable certificate pinning for the API in release builds.
