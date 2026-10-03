import { lazy, Suspense } from 'react';
import type { EChartsReactProps } from 'echarts-for-react/lib/types';

/**
 * A chart, with ECharts loaded the first time one is drawn. The library is
 * most of what the app ships, and the list — what opens first — draws none:
 * it waits until a stock page or the evaluation asks for a chart, and keeps
 * the chart's room meanwhile.
 */
const Core = lazy(() => import('./EChartsCore'));

export default function ReactECharts(props: EChartsReactProps) {
  return (
    <Suspense fallback={<div style={props.style} className={props.className} />}>
      <Core {...props} />
    </Suspense>
  );
}
