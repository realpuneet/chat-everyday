import { ShieldAlert } from 'lucide-react';
import { Link } from 'react-router-dom';

export default function BannedScreen({ info }) {
  const until = info?.until ? new Date(info.until).toLocaleString() : null;
  return (
    <div className="app-vh flex flex-col items-center justify-center gap-3 px-6 text-center">
      <ShieldAlert className="h-12 w-12 text-red-400" aria-hidden="true" />
      <h1 className="h-page">Your access has been restricted</h1>
      <p className="max-w-md text-slate-400">{info?.permanent || !until ? 'This restriction is permanent.' : `This restriction lasts until ${until}.`} It was applied for breaking our community rules or legal requirements.</p>
      <p className="max-w-md text-sm text-slate-500">
        If you believe this is a mistake, contact the{' '}
        <Link className="link" to="/grievance">
          Grievance Officer
        </Link>{' '}
        and quote reference {info?.banId || 'n/a'}.
      </p>
    </div>
  );
}
