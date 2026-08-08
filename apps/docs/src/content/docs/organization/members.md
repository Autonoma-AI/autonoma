---
title: Your team and organizations
description: How people get into an Autonoma organization - automatic joining by email domain, or an invitation - plus how an account can belong to several organizations, how switching between them works, and when leaving one is refused.
---

<p class="lead">An Autonoma account can belong to several organizations. Which one you are working in is a property of your browser session, not of your account.</p>

## Two ways into an organization

**By email domain.** If you signed up with a company address - `you@acme.com` - your organization is keyed to `acme.com`. Anyone who signs in with an `@acme.com` address joins it automatically, with no invitation and nothing for you to configure. Colleagues just sign in.

**By invitation.** If you signed up with a personal address, or through the Vercel Marketplace, there is no shared domain to match on, so nobody can reach your organization on their own. That is what invitations are for.

**Settings → Members is available either way.** On a domain-matched organization, inviting somebody who would join automatically is refused with an explanation - but you can still invite a contractor or consultant whose address is on a different domain, and it is where you leave an organization you no longer want to be in.

## Sending an invitation

1. Open **Settings**, then **Members** under *Organization settings*.
2. Choose **Invite member** and enter their email address.
3. They get an email with a link to review the invitation. It expires after 7 days.

Inviting the same address twice does not create a second invitation - it refreshes the existing one and re-sends it, so any link you have already shared keeps working.

Every member can see and change every application in the organization, and any member can invite others. There are no per-application permissions or roles yet.

### If the email does not arrive

Each pending invitation has a **Copy link** button. The link is the whole invitation, so you can send it over Slack or anywhere else if mail is delayed or filtered. Revoking an invitation invalidates the link immediately.

## Accepting an invitation

The link asks the invitee to sign in, then to confirm.

**Joining is additive.** If they already use Autonoma they keep every organization they were already in - the new one is added alongside. Nothing they had access to before is affected.

An invitation can only be accepted by the address it was sent to. If they are signed in as somebody else, the page says which address to use rather than silently doing nothing.

## Belonging to more than one

Two places let you move between organizations:

- **The organization name at the top of the sidebar** becomes a menu once you belong to more than one.
- **After signing in**, you are asked which organization to start in. With only one you go straight through and never see the question.

Switching applies to **that browser** - two browsers can sit in two different organizations at the same time. Your most recent choice is remembered, so signing in again starts you back where you left off rather than in whichever organization you joined first.

## Naming your organization

If you signed up with a personal address, your organization is initially named after you - because you were the first person through the door, not necessarily because it is yours. The first time you sign in you are asked to name it, with your own name prefilled so keeping it is one click.

You can change it later under **Settings → Members → Your organizations → Rename**. Organizations created from a company email domain are already named after the domain and are never asked.

## Leaving an organization

Under **Settings → Members**, the *Your organizations* panel lists everything your account belongs to, and each row has a **Leave**.

Leaving drops only your own membership. The other members keep theirs, and any of them can invite you back.

Two cases are refused, and the reason is shown on the disabled button:

| Refused when | Why |
| --- | --- |
| It is your **only** organization | An account with no organization cannot reach anything. Join another first. |
| You are its **last member** | Nobody would be left who could reach its applications, and no one could ever be granted access again. Invite someone else first. |

To hand an organization over, invite the new owner, wait for them to accept, then leave.

## Removing someone else

On the *Members* panel, choose the remove icon on their row. They lose access to every application in this organization but keep their Autonoma account and any other organizations they belong to, and can be invited back.

You cannot remove yourself - use **Leave** instead, which enforces the two guards above.
