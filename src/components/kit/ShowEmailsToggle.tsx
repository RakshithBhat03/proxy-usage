import { IconEye, IconEyeOff } from '@/components/ui/icons';
import { usePrivacyStore } from '@/stores/privacy';

/** Header-level "Show emails" pill shared by every page. */
export function ShowEmailsToggle() {
  const show = usePrivacyStore((state) => state.showEmails);
  const toggle = usePrivacyStore((state) => state.toggle);
  return (
    <button type="button" className="kit-pill-button kit-pill-button--lg" aria-pressed={show} onClick={toggle}>
      <span className="kit-pill-button__icon">{show ? <IconEyeOff size={14} /> : <IconEye size={14} />}</span>
      {show ? 'Hide emails' : 'Show emails'}
    </button>
  );
}
