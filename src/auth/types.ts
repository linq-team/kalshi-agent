export interface User {
  phoneNumber: string;
  createdAt: Date;
  lastActive: Date;
  onboardingComplete: boolean;
}

export interface KalshiCredentials {
  apiKeyId: string;
  privateKeyPem: string;
}

export interface AuthToken {
  token: string;
  phoneNumber: string;
  chatId: string;
  createdAt: Date;
  expiresAt: Date;
  used: boolean;
}
