-- Exemplo LasecSimul: contador de 4 bits em VHDL, simulado via GHDL (digital.generic_fpga).
-- `clk` normalmente vem de um componente Clock do esquemático; `count` liga em 4 LEDs.
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity counter is
    port (
        clk   : in  std_logic;
        rst   : in  std_logic;
        count : out std_logic_vector(3 downto 0)
    );
end entity counter;

architecture rtl of counter is
    signal value : unsigned(3 downto 0) := (others => '0');
begin
    process (clk)
    begin
        if rising_edge(clk) then
            if rst = '1' then
                value <= (others => '0');
            else
                value <= value + 1;
            end if;
        end if;
    end process;

    count <= std_logic_vector(value);
end architecture rtl;
