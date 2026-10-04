import EmptyState from '../components/ui/EmptyState.jsx';

export default function NotFound() {
  return (
    <EmptyState icon="alert" title="Page not found" action={{ to: '/', label: 'Go to the start' }} secondary={{ to: '/input', label: 'Step 1: Input' }}>
      That page does not exist. Your resume and results are still saved in this browser.
    </EmptyState>
  );
}
