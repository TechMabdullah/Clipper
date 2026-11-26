import * as React from 'react';
import {
  Html,
  Head,
  Preview,
  Body,
  Container,
  Heading,
  Text,
  Hr,
} from '@react-email/components';

interface NotificationAlertEmailProps {
  title: string;
  bodyText: string;
  actionNote?: string;
}

export function NotificationAlertEmail({
  title,
  bodyText,
  actionNote,
}: NotificationAlertEmailProps) {
  return (
    <Html>
      <Head />
      <Preview>{title}</Preview>
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
            padding: '32px',
          }}
        >
          <Text style={{ fontSize: '16px', fontWeight: 800, color: '#6C63FF', margin: '0 0 16px 0' }}>
            🎬 Clipper Studio Alert
          </Text>
          <Heading style={{ fontSize: '22px', fontWeight: 800, margin: '0 0 12px 0' }}>
            {title}
          </Heading>
          <Text style={{ fontSize: '14.5px', lineHeight: '22px', color: '#4B4E6D' }}>
            {bodyText}
          </Text>
          {actionNote ? (
            <Text style={{ fontSize: '13px', color: '#6C63FF', fontWeight: 600, marginTop: '16px' }}>
              {actionNote}
            </Text>
          ) : null}
          <Hr style={{ borderColor: '#E6E8F5', margin: '20px 0' }} />
          <Text style={{ fontSize: '12px', color: '#8C8FA8', margin: 0 }}>
            Sent by Clipper Studio RBAC &amp; Security Control Plane
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

export default NotificationAlertEmail;
