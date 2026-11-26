import * as React from 'react';
import {
  Html,
  Head,
  Preview,
  Body,
  Container,
  Section,
  Heading,
  Text,
  Hr,
} from '@react-email/components';

interface OtpEmailProps {
  name?: string;
  code: string;
  expiresMinutes?: number;
}

export function OtpVerificationEmail({
  name = 'Creator',
  code,
  expiresMinutes = 5,
}: OtpEmailProps) {
  return (
    <Html>
      <Head />
      <Preview>Your Clipper Studio verification code: {code}</Preview>
      <Body
        style={{
          backgroundColor: '#F7F6FB',
          fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
          padding: '32px 16px',
          color: '#1A1A2E',
        }}
      >
        <Container
          style={{
            maxWidth: '520px',
            margin: '0 auto',
            backgroundColor: '#FFFFFF',
            border: '1px solid #E6E8F5',
            borderRadius: '24px',
            padding: '36px 32px',
          }}
        >
          <Section style={{ marginBottom: '20px' }}>
            <Text
              style={{
                fontSize: '18px',
                fontWeight: 800,
                color: '#6C63FF',
                margin: 0,
              }}
            >
              🎬 Clipper Studio
            </Text>
          </Section>

          <Heading
            style={{
              fontSize: '26px',
              fontWeight: 800,
              color: '#1A1A2E',
              margin: '0 0 10px 0',
              letterSpacing: '-0.02em',
            }}
          >
            Confirm it’s really you
          </Heading>

          <Text style={{ fontSize: '15px', lineHeight: '24px', color: '#4B4E6D', margin: '0 0 24px 0' }}>
            Hey {name}, enter this one-time 6-digit verification code to unlock your dashboard session:
          </Text>

          <Section
            style={{
              backgroundColor: '#F7F6FB',
              border: '2px dashed #6C63FF',
              borderRadius: '18px',
              padding: '22px',
              textAlign: 'center',
              marginBottom: '24px',
            }}
          >
            <Text
              style={{
                fontSize: '36px',
                fontWeight: 800,
                letterSpacing: '0.28em',
                color: '#1A1A2E',
                margin: 0,
              }}
            >
              {code}
            </Text>
          </Section>

          <Text style={{ fontSize: '13.5px', lineHeight: '20px', color: '#646782', margin: '0 0 18px 0' }}>
            This code expires in <strong>{expiresMinutes} minutes</strong> and can only be used once. If you didn’t try signing in, you can safely ignore this message.
          </Text>

          <Hr style={{ borderColor: '#E6E8F5', margin: '20px 0' }} />

          <Text style={{ fontSize: '12px', color: '#8C8FA8', margin: 0 }}>
            Clipper Studio • Local-First AI Clipping &amp; SaaS Control Plane
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

export default OtpVerificationEmail;
