function y = downsample(x, n)
% DOWNSAMPLE  Keep every Nth sample, starting with the first: x(1:n:end).
%
%   MSPTDfast calls MATLAB's Signal Processing Toolbox downsample(x, n), which
%   with no phase argument is exactly this. Octave keeps it in the separate
%   `signal` package; this shim spares installing that.
y = x(1:n:end);
end
