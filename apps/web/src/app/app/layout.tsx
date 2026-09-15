import { AppShell } from '@/components/layout/AppShell';

export default function DappLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
