import { Suspense } from 'react';
import type { Metadata } from 'next';
import { SubmitForm } from '@/components/submit/SubmitForm';

export const metadata: Metadata = { title: 'Submit a receipt' };

export default function SubmitPage() {
  // SubmitForm reads ?brand= via useSearchParams, which needs a Suspense
  // boundary or Next bails out of prerendering the route.
  return (
    <Suspense fallback={<div className="skeleton h-96 w-full rounded-card" />}>
      <SubmitForm />
    </Suspense>
  );
}
