import { redirect } from 'next/navigation';

/** /app is the shell. Portfolio is what you actually want to see first. */
export default function AppIndex() {
  redirect('/app/portfolio');
}
