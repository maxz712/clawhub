export interface OAuthProfile {
  email: string;
  name?: string;
  avatarUrl?: string;
  providerId: string;
}

interface GitHubTokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
}

interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
  avatar_url: string;
}

interface GitHubEmail {
  email: string;
  primary: boolean;
  verified: boolean;
}

interface GoogleTokenResponse {
  id_token?: string;
  error?: string;
  error_description?: string;
}

export async function exchangeGitHubCode(code: string): Promise<OAuthProfile> {
  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("GitHub OAuth is not configured");
  }

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

  const tokenData = (await tokenRes.json()) as GitHubTokenResponse;

  if (tokenData.error) {
    throw new Error(
      tokenData.error_description || `GitHub OAuth error: ${tokenData.error}`
    );
  }

  const accessToken = tokenData.access_token;

  const userRes = await fetch("https://api.github.com/user", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!userRes.ok) {
    throw new Error("Failed to fetch GitHub user profile");
  }

  const user = (await userRes.json()) as GitHubUser;

  let email = user.email;
  if (!email) {
    const emailsRes = await fetch("https://api.github.com/user/emails", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (emailsRes.ok) {
      const emails = (await emailsRes.json()) as GitHubEmail[];
      const primary = emails.find((e) => e.primary && e.verified);
      if (primary) email = primary.email;
    }
  }

  if (!email) {
    throw new Error(
      "Could not retrieve email from GitHub. Ensure your email is verified."
    );
  }

  return {
    email,
    name: user.name || user.login,
    avatarUrl: user.avatar_url,
    providerId: String(user.id),
  };
}

export async function exchangeGoogleCode(
  code: string,
  redirectUri: string
): Promise<OAuthProfile> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("Google OAuth is not configured");
  }

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  const tokenData = (await tokenRes.json()) as GoogleTokenResponse;

  if (tokenData.error) {
    throw new Error(
      tokenData.error_description || `Google OAuth error: ${tokenData.error}`
    );
  }

  const idToken = tokenData.id_token;
  if (!idToken) {
    throw new Error("No id_token returned from Google");
  }

  const payloadSegment = idToken.split(".")[1];
  const payload = JSON.parse(
    Buffer.from(payloadSegment, "base64url").toString("utf-8")
  ) as {
    email?: string;
    email_verified?: boolean;
    name?: string;
    picture?: string;
    sub: string;
  };

  if (!payload.email) {
    throw new Error("No email in Google ID token");
  }

  if (!payload.email_verified) {
    throw new Error("Google email is not verified");
  }

  return {
    email: payload.email,
    name: payload.name,
    avatarUrl: payload.picture,
    providerId: payload.sub,
  };
}
