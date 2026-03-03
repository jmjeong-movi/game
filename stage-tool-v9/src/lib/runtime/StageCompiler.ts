// 역할: StageCompiler 진입점(호환 유지)
// - 원래 파일 경로(./StageCompiler)를 유지하면서 내부 구현을 stage/ 폴더로 분리합니다.
export { compileRuntimeFromV2 } from './stage/compileRuntimeFromV2';
