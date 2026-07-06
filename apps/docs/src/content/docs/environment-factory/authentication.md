---
title: Authentication
description: The auth callback turns a created User into real, working credentials the test runner uses to log in. Covers session cookies, bearer tokens, and email/password credentials for mobile.
---

The `auth` callback is what lets the test runner log in as the user your `up` request created. It receives that user and returns credentials the runner authenticates with.

:::caution
This is the single most common place setups break. If `auth` returns a fake or expired token, **every test fails at the login step** - no matter how good your factories are.
:::

## What the callback receives

```typescript
auth: async (user, context) => {
  // user: the first User record from refs, or null if the scenario has no User.
  //   Always handle null. Shape: { id, name, email, ... }
  // context:
  //   scopeValue - the detected scope value (e.g. organization id), or the testRunId fallback
  //   refs       - all created records, keyed by model, for looking up related data
}
```

Not every scenario creates a `User`, so `user` can be `null`. Guard for it.

## What the callback returns

```typescript
interface AuthResult {
  cookies?: Array<{
    name: string
    value: string
    httpOnly?: boolean
    sameSite?: 'strict' | 'lax' | 'none'
    path?: string
    domain?: string
    secure?: boolean
    maxAge?: number
  }>
  headers?: Record<string, string>       // custom headers, e.g. Authorization: Bearer ...
  credentials?: Record<string, string>   // key/value pairs for a manual login flow
}
```

There is no top-level `token` field. Return a bearer token on `headers`; return login credentials on `credentials`.

## Pattern 1 - Session cookies

The default for most server-rendered web apps. Create a real session and return its cookie.

```typescript
auth: async (user) => {
  const session = await lucia.createSession(user!.id, {})
  const cookie = lucia.createSessionCookie(session.id)
  return {
    cookies: [{
      name: cookie.name,
      value: cookie.value,
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
    }],
  }
}
```

## Pattern 2 - Bearer token

For APIs and SPAs that authenticate with an `Authorization` header.

```typescript
auth: async (user) => {
  const token = jwt.sign(
    { sub: user!.id, email: user!.email },
    process.env.JWT_SECRET!,
    { expiresIn: '1h' },
  )
  return { headers: { Authorization: `Bearer ${token}` } }
}
```

## Pattern 3 - Email/password credentials

When the agent needs to log in through your app's actual login screen instead of receiving a cookie or token, return credentials.

```typescript
auth: async (user) => ({
  credentials: {
    email: user!.email,
    password: 'test-password-123',
  },
})
```

For this to work, the `User` must be created with a **known password**. Hash it in the User factory during `create`:

```typescript
User: defineFactory({
  inputSchema: z.object({ email: z.string(), name: z.string() }),
  create: async (data) =>
    userService.create({ ...data, password: 'test-password-123' }),
})
```

## Common mistakes

| Mistake | What happens | Fix |
| --- | --- | --- |
| Returning a hardcoded `"test-token"` | Every test fails at login | Use your real session / JWT creation |
| No password set on the User | Email/password login fails | Hash a known password in the User factory |
| Token expires too quickly | Tests fail midway through | Set expiry to at least 1 hour |
| Wrong cookie name | The browser never sends the cookie | Check your app's real cookie name in DevTools |

:::note
The one-hour expiry above is for the **login token you return here** (the session cookie or JWT). It has nothing to do with the Environment Factory's internal teardown token, which the SDK signs and manages itself and which expires after 24 hours - see [Security](/environment-factory/security/).
:::
