import * as React from 'react';
import { Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer';

const styles = StyleSheet.create({
  page: {
    padding: 40,
    fontFamily: 'Helvetica',
    backgroundColor: '#FFFFFF',
    color: '#1A1A2E',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 24,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#E6E8F5',
  },
  brand: { fontSize: 20, fontWeight: 'bold', color: '#6C63FF' },
  subtitle: { fontSize: 10, color: '#64748B', marginTop: 4 },
  sectionTitle: { fontSize: 12, fontWeight: 'bold', marginTop: 18, marginBottom: 8 },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#F1F2FA',
    fontSize: 11,
  },
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 16,
    paddingTop: 12,
    borderTopWidth: 2,
    borderTopColor: '#6C63FF',
    fontSize: 13,
    fontWeight: 'bold',
  },
  footer: { marginTop: 32, fontSize: 9, color: '#64748B' },
});

export interface InvoicePdfProps {
  orderId: string;
  customerName: string;
  customerEmail: string;
  planLabel: string;
  statusLabel: string;
  amountDisplay: string;
  issuedDate: string;
}

export function buildInvoicePdfDocument(props: InvoicePdfProps) {
  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <View style={styles.header}>
          <View>
            <Text style={styles.brand}>Clipper Studio</Text>
            <Text style={styles.subtitle}>Creator SaaS Receipt & Invoice</Text>
          </View>
          <View>
            <Text style={{ fontSize: 12, fontWeight: 'bold' }}>Invoice #{props.orderId}</Text>
            <Text style={styles.subtitle}>Issued: {props.issuedDate}</Text>
          </View>
        </View>

        <Text style={styles.sectionTitle}>Billed To</Text>
        <Text style={{ fontSize: 11 }}>{props.customerName}</Text>
        <Text style={{ fontSize: 10, color: '#64748B', marginTop: 2 }}>{props.customerEmail}</Text>

        <Text style={styles.sectionTitle}>Line Items</Text>
        <View style={styles.row}>
          <Text>{props.planLabel}</Text>
          <Text>{props.amountDisplay}</Text>
        </View>
        <View style={styles.row}>
          <Text>Payment Status</Text>
          <Text>{props.statusLabel.toUpperCase()}</Text>
        </View>

        <View style={styles.totalRow}>
          <Text>Total</Text>
          <Text>{props.amountDisplay}</Text>
        </View>

        <Text style={styles.footer}>
          Clipper Studio · Automated AI clipping, split-facecam rendering, and multi-platform creator
          publishing. Generated dynamically on request.
        </Text>
      </Page>
    </Document>
  );
}
