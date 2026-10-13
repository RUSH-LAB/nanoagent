-- Invitations addressed to a GitHub account rather than an email address
-- (org.js), beside Better Auth's own invitation table. Better Auth accepts an
-- invitation only from the session whose email it names, so these are kept and
-- accepted here, and the membership is still Better Auth's to create. The
-- account is GitHub's numeric id, resolved from the username when the invitation
-- is made, because a username can be renamed and then claimed by someone else;
-- the username is kept to show.

create table "githubInvitation" ("id" text not null primary key, "organizationId" text not null references "organization" ("id") on delete cascade, "githubId" text not null, "githubLogin" text not null, "role" text not null, "status" text not null, "expiresAt" date not null, "createdAt" date not null, "inviterId" text not null references "user" ("id") on delete cascade);

create index "githubInvitation_organizationId_idx" on "githubInvitation" ("organizationId");

create index "githubInvitation_githubId_idx" on "githubInvitation" ("githubId");
