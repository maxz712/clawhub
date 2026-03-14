import { ValidationError } from "./errors.js";

export interface OAuthProfile {
  email: string;
  name?: string;
  avatarUrl?: string;
  providerId: string;
}

export async function exchangeGitHubCode(code: string): Promise<OAuthProfile> {
  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new ValidationError(
      "OAuth authentication failed: GitHub OAuth is not configured"
    );
  }

  // Exchange code for access token
  const tokenRes = await fetch(
    "https://github.com/login/oauth/access_token",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
      }),
    }
  );

  const tokenData = (await tokenRes.json()) as Record<string, unknown>;

  if (tokenData.error) {
    throw new ValidationError(
      `OAuth authentication failed: ${tokenData.error_description || tokenData.error}`
    );
  }

  const accessToken = tokenData.access_token as string;

  // Fetch user profile
  const userRes = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  if (!userRes.ok) {
    throw new ValidationError(
      "OAuth authentication failed: could not fetch GitHub user profile"
    );
  }

  const userData = (await userRes.json()) as Record<string, unknown>;

  let email = userData.email as string | null;

  // If email is not public, fetch from /user/emails
  if (!email) {
    const emailsRes = await fetch("https://api.github.com/user/emails", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });

    if (emailsRes.ok) {
      const emails = (await emailsRes.json()) as Array<{
        email: string;
        primary: boolean;
        verified: boolean;
      }>;
      const primary = emails.find((e) => e.primary && e.verified);
      if (primary) {
        email = primary.email;
      }
    }
  }

  if (!email) {
    throw new ValidationError(
      "OAuth authentication failed: could not retrieve email from GitHub"
    );
  }

  return {
    email,
    name: (userData.name as string) || undefined,
    avatarUrl: (userData.avatar_url as string) || undefined,
    providerId: String(userData.id),
  };
}

export async function exchangeGoogleCode(
  code: string,
  redirectUri: string
): Promise<OAuthProfile> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new ValidationError(
      "OAuth authentication failed: Google OAuth is not configured"
    );
  }

  // Exchange code for tokens
  const params = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  const tokenData = (await tokenRes.json()) as Record<string, unknown>;

  if (tokenData.error) {
    throw new ValidationError(
      `OAuth authentication failed: ${tokenData.error_description || tokenData.error}`
    );
  }

  const idToken = tokenData.id_token as string;

  if (!idToken) {
    throw new ValidationError(
      "OAuth authentication failed: no id_token in Google response"
    );
  }

  // Decode the JWT payload (base64url decode, no verification needed)
  const parts = idToken.split(".");
  if (parts.length !== 3) {
    throw new ValidationError(
      "OAuth authentication failed: malformed id_token"
    );
  }

  const payloadBase64 = parts[1]
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const payloadJson = Buffer.from(payloadBase64, "base64").toString("utf-8");
  const payload = JSON.parse(payloadJson) as Record<string, unknown>;

  const email = payload.email as string | undefined;
  if (!email) {
    throw new ValidationError(
      "OAuth authentication failed: no email in Google id_token"
    );
  }

  return {
    email,
    name: (payload.name as string) || undefined,
    avatarUrl: (payload.picture as string) || undefined,
    providerId: payload.sub as string,
  };
}
