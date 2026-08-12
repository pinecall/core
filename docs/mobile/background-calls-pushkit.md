---
title: "Background & killed-app calls"
description: "Ring a backgrounded or killed iOS app with PushKit VoIP pushes — reference implementation for @pinecall/ionic."
---

# Background & killed-app calls (PushKit / VoIP push)

> ## ⚠️ Requires a paid Apple Developer account ($99/yr)
>
> Everything else in `@pinecall/ionic` works with a **free** Apple ID. Ringing a
> **backgrounded or killed** app is the one feature that doesn't — it needs a
> **VoIP Services push certificate**, which Apple only issues to paid Developer
> Program members. There is no workaround, hack, or simulator path: VoIP pushes
> are delivered by APNs to real devices only.
>
> This page is a **reference implementation** — the exact code you'd add once
> you have the account. It is intentionally **not** wired into the plugin build,
> so the free-tier experience keeps compiling.

## Why the in-app flow isn't enough

The shipped plugin rings via `CXProvider.reportNewIncomingCall` — which works
only while **your app's JS is running** (foreground, or briefly backgrounded).
If the app is suspended or killed, there is no JS to call `startCall`.

The OS-level solution is **PushKit**: your server sends a special *VoIP* push,
iOS **wakes your app in the background** (even if killed) and calls a native
delegate, and you report the incoming call to CallKit from there — all before
the user has opened anything. That's how WhatsApp/Telegram ring you cold.

```
agent wants to call you
  → your backend sends a VoIP push via APNs (token = the device's PushKit token)
    → iOS wakes the app in the background, calls pushRegistry(didReceiveIncomingPushWith:)
      → you MUST synchronously reportNewIncomingCall → 📱 CallKit rings (lock screen)
        → user answers → PinecallCallController.connectWebRTC() (same as today)
```

> **Hard rule (iOS kills you otherwise):** in `didReceiveIncomingPushWith` you
> must call `reportNewIncomingCall` **every time**, synchronously, before the
> handler returns. Skipping it (even to reject) crashes/burns your push
> privileges.

## 1. One-time setup (paid account)

1. Xcode → target **Signing & Capabilities** → **+ Capability** → **Push
   Notifications**, and add **Background Modes → Voice over IP**.
2. Create a **VoIP Services Certificate** (or an APNs **Auth Key**, preferred)
   in the Apple Developer portal. Keep it on your backend.

`ios/App/App/App.entitlements` ends up with:

```xml
<key>aps-environment</key>
<string>development</string>
```

## 2. Native — register for VoIP pushes and ring on arrival

A small addition to the plugin (`PinecallCallController` already knows how to
ring + connect; PushKit just feeds it a call when the app is asleep).

```swift
// ios/App/App/PushKitService.swift  (example)
import PushKit
import CallKit

final class PushKitService: NSObject, PKPushRegistryDelegate {
    static let shared = PushKitService()
    private let registry = PKPushRegistry(queue: .main)

    /// Emitted so JS can upload the token to your backend.
    var onToken: ((String) -> Void)?

    func start() {
        registry.delegate = self
        registry.desiredPushTypes = [.voIP]
    }

    func pushRegistry(_ registry: PKPushRegistry,
                      didUpdate pushCredentials: PKPushCredentials,
                      for type: PKPushType) {
        let token = pushCredentials.token.map { String(format: "%02x", $0) }.joined()
        onToken?(token)
    }

    // iOS wakes the app here — even if it was killed.
    func pushRegistry(_ registry: PKPushRegistry,
                      didReceiveIncomingPushWith payload: PKPushPayload,
                      for type: PKPushType,
                      completion: @escaping () -> Void) {
        let info = payload.dictionaryPayload
        let callId   = info["callId"]     as? String ?? UUID().uuidString
        let name     = info["callerName"] as? String ?? "AI agent"
        let handle   = info["handle"]     as? String ?? name
        let tokenUrl = info["tokenUrl"]   as? String ?? ""

        // MUST report synchronously, or iOS terminates the app.
        PinecallCallController.shared.startCall(
            .init(callId: callId, callerName: name, handle: handle,
                  tokenUrl: tokenUrl, direction: "incoming")
        ) { _ in completion() }
    }
}
```

Wire it up in `AppDelegate.application(_:didFinishLaunchingWithOptions:)`:

```swift
PushKitService.shared.start()
```

Expose the token to JS (add to `PinecallCallPlugin`), so the app can register
the device with your backend:

```swift
override public func load() {
    // …existing wiring…
    PushKitService.shared.onToken = { [weak self] token in
        self?.notifyListeners("voipToken", data: ["token": token])
    }
}
```

```ts
// JS — send the device's VoIP token to your backend after login
PinecallCall.addListener('voipToken', ({ token }) => {
  fetch('https://your-backend.com/api/register-voip', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, voipToken: token, platform: 'ios' }),
  });
});
```

## 3. Backend — send the VoIP push when the agent should call

When your logic decides "call this user", send an APNs push to their stored
VoIP token, on the **`voip`** topic (`<bundleId>.voip`), priority 10.

```js
// Node example with node-apn (APNs Auth Key .p8)
import apn from '@parse/node-apn';

const provider = new apn.Provider({
  token: {
    key: process.env.APNS_KEY_P8,      // -----BEGIN PRIVATE KEY----- …
    keyId: process.env.APNS_KEY_ID,    // e.g. "ABC123DEFG"
    teamId: process.env.APPLE_TEAM_ID, // e.g. "9NXCWVVZ7P"
  },
  production: false, // true for TestFlight/App Store builds
});

export async function ringUser(voipToken, { agentId, callerName, tokenUrl }) {
  const note = new apn.Notification();
  note.topic = 'io.pinecall.app.voip';   // ⚠️ MUST be <bundleId>.voip
  note.pushType = 'voip';
  note.priority = 10;
  note.expiry = Math.floor(Date.now() / 1000) + 30;
  note.payload = {
    callId: `pc-${agentId}-${Date.now()}`,
    callerName,
    handle: 'AI voice agent',
    tokenUrl,                            // same /api/token the plugin already uses
  };
  const res = await provider.send(note, voipToken);
  if (res.failed.length) console.error('VoIP push failed', res.failed);
}
```

That's it: the push wakes the app → the app rings via the same
`PinecallCallController` you already have → answering runs the identical native
WebRTC path. **Outbound, in-app inbound, and this cold inbound all converge on
one call controller** — only the *trigger* differs.

## Testing without writing a backend

Once the certificate exists, you can fire a test VoIP push straight from your
Mac with [`node-apn`](https://github.com/parse-community/node-apn) or the
`push` CLI, targeting the device token you logged in step 2 — no server
deploy needed. (Still a real device; the simulator never receives VoIP pushes.)

## Free-tier alternative (what ships today)

Without the paid account you still get the full call experience **while the app
is open**: outgoing calls, and the agent ringing you via the in-app SSE trigger
(`examples/app/server` → `POST /api/ring`). Only the *cold wake* needs PushKit.

## What's next

- [`@pinecall/ionic` overview](/mobile/ionic-overview) — install, API, platform support
- [`@pinecall/react-native`](/mobile/react-native) — same architecture, same API
