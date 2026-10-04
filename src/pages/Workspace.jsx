import EmptyState from '../components/ui/EmptyState.jsx';

// Still routed at /app so old links land somewhere, but nothing links here:
// the workspace is the four-step wizard.
export default function Workspace() {
  return (
    <EmptyState icon="layers" title="The workspace is the four steps" action={{ to: '/input', label: 'Go to step 1' }}>
      A2Resume works through Input, Analyze, Tailor and Export, in the header above. Start with your resume on step 1.
    </EmptyState>
  );
}
