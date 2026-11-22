import { expect, test } from 'vitest'
import { parseLayoutDescription } from './catalog'

test('合schema的布局: 视图表以id为键, 布局树只引用id, 绑定按种类与角色可通配', () => {
  const result = parseLayoutDescription({
    version: 1,
    views: {
      head: { type: 'image', title: '头部相机', layers: [{ kind: 'image_stream', role: 'camera', name: 'head' }] },
      scene: { type: 'scene3d', frame: 'base_link', layers: [{ kind: 'series', role: 'end_effector_position' }] },
      joints: { type: 'series', layers: [{ kind: 'series', role: '*joint_position', visible: false }] },
    },
    layout: {
      type: 'split',
      direction: 'column',
      children: [
        { type: 'tabs', views: ['head', 'scene'], active: 'scene', size: 2 },
        { type: 'tabs', views: ['joints'] },
      ],
    },
  })
  expect(result.success).toBe(true)
})

test('视图类型限定可叠的图层种类: 图像视图不能叠序列', () => {
  const result = parseLayoutDescription({
    version: 1,
    views: { head: { type: 'image', layers: [{ kind: 'series' }] } },
    layout: { type: 'tabs', views: ['head'] },
  })
  expect(result.success).toBe(false)
  if (!result.success) expect(result.issues.join('\n')).toMatch(/views\.head\.layers\.0\.kind/)
})

test('tab组的active须是其中的视图', () => {
  const result = parseLayoutDescription({
    version: 1,
    views: { events: { type: 'events', layers: [{ kind: 'events' }] } },
    layout: { type: 'tabs', views: ['events'], active: 'scene' },
  })
  expect(result.success).toBe(false)
})
