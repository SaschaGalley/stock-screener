// The ES module build: the CommonJS one arrives in the dev server as `{ default }`, not a component.
import ReactEChartsCore from 'echarts-for-react/esm/core';
import type { EChartsReactProps } from 'echarts-for-react/lib/types';
import * as echarts from 'echarts/core';
import { BarChart, CandlestickChart, GaugeChart, LineChart, SankeyChart, ScatterChart } from 'echarts/charts';
import {
  DataZoomComponent, GridComponent, LegendComponent, MarkAreaComponent, MarkLineComponent, MarkPointComponent,
  TitleComponent, TooltipComponent,
} from 'echarts/components';
import { CanvasRenderer, SVGRenderer } from 'echarts/renderers';

/**
 * ECharts with only what the app draws: lines, bars, candles, scatter, a gauge
 * and a Sankey, on a grid with tooltips, legends and marks. The whole library was
 * most of a 1.7 MB bundle; a chart type added to an option must be added here
 * too, or ECharts logs that the series type is not registered.
 */
echarts.use([
  BarChart, CandlestickChart, GaugeChart, LineChart, SankeyChart, ScatterChart,
  DataZoomComponent, GridComponent, LegendComponent, MarkAreaComponent, MarkLineComponent, MarkPointComponent,
  TitleComponent, TooltipComponent,
  CanvasRenderer, SVGRenderer,
]);

export default function ReactECharts(props: EChartsReactProps) {
  return <ReactEChartsCore echarts={echarts} {...props} />;
}
