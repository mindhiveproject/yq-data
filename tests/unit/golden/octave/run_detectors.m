function run_detectors(in_path, out_path)
% RUN_DETECTORS  Runs the ppg-beats reference beat detectors over a batch.
%
%   Called by ref_cardiac.py. Reads {"cases": [{"fs": .., "x": [..]}, ..]}
%   from IN_PATH and writes, per case, the 1-based peak and onset indices of
%   MSPTDfast v2 and qppgfast to OUT_PATH as JSON.
%
%   Calls the toolbox's own wrappers (msptdfastv2_beat_detector.m,
%   qppgfast_beat_detector.m), unchanged, from the pinned commit that
%   ref_cardiac.py downloads.
doc = jsondecode(fileread(in_path));
cases = doc.cases;
out = cell(1, numel(cases));
for c = 1:numel(cases)
  if iscell(cases), cs = cases{c}; else, cs = cases(c); end
  x = double(cs.x(:));
  [p, o] = msptdfastv2_beat_detector(x, cs.fs);
  [qp, qo] = qppgfast_beat_detector(x, cs.fs);
  % Wrap each list in a cell so jsonencode writes an array even for 0 or 1
  % elements.
  out{c} = struct( ...
    'msptdfastv2_peaks', {num2cell(p(:)')}, ...
    'msptdfastv2_onsets', {num2cell(o(:)')}, ...
    'qppgfast_peaks', {num2cell(qp(:)')}, ...
    'qppgfast_onsets', {num2cell(qo(:)')});
end
fid = fopen(out_path, 'w');
fputs(fid, jsonencode(out));
fclose(fid);
end
