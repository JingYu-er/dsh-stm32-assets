/**
 * 手写兜底：拿不到 ST 官方 SVD 时最少要有的那份「外设 → 寄存器 → 位域」子集。
 *
 * 只有构建脚本把三条路都走死（--svd 没给、缓存没有、下载失败、仓库里也没有上次生成的
 * svd-f1.json）时才会用到这里。内容按 RM0008（STM32F10xxx 参考手册）手抄，覆盖：
 *   GPIOA..GPIOE（CRL/CRH/IDR/ODR/BSRR/BRR/LCKR）、RCC、FLASH、USART1、TIM2
 * 其余外设（TIM、SPI、I2C、ADC、CAN、USB、DMA、EXTI、AFIO……）都没有——这是子集，
 * 不是完整 SVD。生成时 notes 会把这件事写明，manifest 里 source.kind 标 handwritten。
 *
 * 改这里的数据要一起改 stm32f1 的下载器文档口径（同一个 svd-f1.json 的两种来源）。
 */

/** 位域生成小工具：一位的（MODE/ODR/BS…）与多位的（CNF/MODE…）分开写，读起来像手册。 */
const one = (name, bitOffset) => ({ name, bitOffset, bitWidth: 1 });
const many = (name, bitOffset, bitWidth) => ({ name, bitOffset, bitWidth });

/** GPIO 的 7 个寄存器：A..E 五个口完全同构，只差基地址。 */
function gpioRegisters() {
    const crl = [];
    const crh = [];
    for (let pin = 0; pin < 8; pin += 1) {
        crl.push(many("MODE" + pin, pin * 2, 2));
        crl.push(many("CNF" + pin, pin * 2 + 2, 2));
    }
    for (let pin = 8; pin < 16; pin += 1) {
        const offset = (pin - 8) * 2;
        crh.push(many("MODE" + pin, offset, 2));
        crh.push(many("CNF" + pin, offset + 2, 2));
    }
    const idr = [];
    const odr = [];
    const bsrr = [];
    const brr = [];
    const lckr = [];
    for (let pin = 0; pin < 16; pin += 1) {
        idr.push(one("IDR" + pin, pin));
        odr.push(one("ODR" + pin, pin));
        bsrr.push(one("BS" + pin, pin));
        bsrr.push(one("BR" + pin, pin + 16));
        brr.push(one("BR" + pin, pin));
        lckr.push(one("LCK" + pin, pin));
    }
    lckr.push(one("LCKK", 16));
    return [
        { name: "CRL", addressOffset: "0x00", size: 32, access: "read-write", fields: crl },
        { name: "CRH", addressOffset: "0x04", size: 32, access: "read-write", fields: crh },
        { name: "IDR", addressOffset: "0x08", size: 32, access: "read-only", fields: idr },
        { name: "ODR", addressOffset: "0x0C", size: 32, access: "read-write", fields: odr },
        { name: "BSRR", addressOffset: "0x10", size: 32, access: "write-only", fields: bsrr },
        { name: "BRR", addressOffset: "0x14", size: 32, access: "write-only", fields: brr },
        { name: "LCKR", addressOffset: "0x18", size: 32, access: "read-write", fields: lckr },
    ];
}

/** RCC（RM0008 §8.3）：常用的是 CR/CFGR/CIR/APB2ENR/APB1ENR/BDCR/CSR。 */
function rccPeripheral() {
    return {
        name: "RCC",
        baseAddress: "0x40021000",
        registers: [
            {
                name: "CR",
                addressOffset: "0x00",
                size: 32,
                access: "read-write",
                fields: [
                    one("HSION", 0), one("HSIRDY", 1), one("HSITRIM", 3), one("HSICAL", 8),
                    one("HSEON", 16), one("HSERDY", 17), one("HSEBYP", 18), one("CSSON", 19),
                    one("PLLON", 24), one("PLLRDY", 25),
                ],
            },
            {
                name: "CFGR",
                addressOffset: "0x04",
                size: 32,
                access: "read-write",
                fields: [
                    many("SW", 0, 2), many("SWS", 2, 2), many("HPRE", 4, 4), many("PPRE1", 8, 3),
                    many("PPRE2", 11, 3), many("ADCPRE", 14, 2), many("PLLSRC", 16, 1),
                    many("PLLXTPRE", 17, 1), many("PLLMUL", 18, 4), many("USBPRE", 22, 1),
                    many("MCO", 24, 3),
                ],
            },
            {
                name: "CIR",
                addressOffset: "0x08",
                size: 32,
                access: "read-write",
                fields: [
                    one("LSIRDYF", 0), one("LSERDYF", 1), one("HSIRDYF", 2), one("HSERDYF", 3),
                    one("PLLRDYF", 4), one("CSSF", 7), one("LSIRDYIE", 8), one("LSERDYIE", 9),
                    one("HSIRDYIE", 10), one("HSERDYIE", 11), one("PLLRDYIE", 12),
                    one("LSIRDYC", 16), one("LSERDYC", 17), one("HSIRDYC", 18), one("HSERDYC", 19),
                    one("PLLRDYC", 20), one("CSSC", 23),
                ],
            },
            {
                name: "APB2ENR",
                addressOffset: "0x18",
                size: 32,
                access: "read-write",
                fields: [
                    one("AFIOEN", 0), one("IOPAEN", 2), one("IOPBEN", 3), one("IOPCEN", 4),
                    one("IOPDEN", 5), one("IOPEEN", 6), one("IOPFEN", 7), one("IOPGEN", 8),
                    one("ADC1EN", 9), one("ADC2EN", 10), one("TIM1EN", 11), one("SPI1EN", 12),
                    one("TIM8EN", 13), one("USART1EN", 14), one("ADC3EN", 15),
                    one("TIM9EN", 19), one("TIM10EN", 20), one("TIM11EN", 21),
                ],
            },
            {
                name: "APB1ENR",
                addressOffset: "0x1C",
                size: 32,
                access: "read-write",
                fields: [
                    one("TIM2EN", 0), one("TIM3EN", 1), one("TIM4EN", 2), one("TIM5EN", 3),
                    one("TIM6EN", 4), one("TIM7EN", 5), one("TIM12EN", 6), one("TIM13EN", 7),
                    one("TIM14EN", 8), one("WWDGEN", 11), one("SPI2EN", 14), one("SPI3EN", 15),
                    one("USART2EN", 17), one("USART3EN", 18), one("UART4EN", 19),
                    one("UART5EN", 20), one("I2C1EN", 21), one("I2C2EN", 22),
                    one("USBEN", 23), one("CANEN", 25), one("BKPEN", 27), one("PWREN", 28),
                    one("DACEN", 29),
                ],
            },
            {
                name: "BDCR",
                addressOffset: "0x20",
                size: 32,
                access: "read-write",
                fields: [one("LSEON", 0), one("LSERDY", 1), one("LSEBYP", 2), many("RTCSEL", 8, 2), one("RTCEN", 15), one("BDRST", 16)],
            },
            {
                name: "CSR",
                addressOffset: "0x24",
                size: 32,
                access: "read-write",
                fields: [one("LSION", 0), one("LSIRDY", 1), one("RMVF", 24), one("PINRSTF", 26), one("PORRSTF", 27), one("SFTRSTF", 28), one("IWDGRSTF", 29), one("WWDGRSTF", 30), one("LPWRRSTF", 31)],
            },
            {
                name: "AHBENR",
                addressOffset: "0x14",
                size: 32,
                access: "read-write",
                fields: [one("DMA1EN", 0), one("DMA2EN", 1), one("SRAMEN", 2), one("FLITFEN", 4), one("CRCEN", 6), one("FSMCEN", 8), one("SDIOEN", 10)],
            },
        ],
    };
}

/** FLASH 接口寄存器（RM0008 §3.3.3）：ACR 在 0x40022000，KEYR/SR/CR/AR/OBR/WRPR 跟在后面。 */
function flashPeripheral() {
    return {
        name: "FLASH",
        baseAddress: "0x40022000",
        registers: [
            {
                name: "ACR",
                addressOffset: "0x00",
                size: 32,
                access: "read-write",
                fields: [many("LATENCY", 0, 3), one("HLFCYA", 3), one("PRFTBE", 4), one("PRFTBS", 5)],
            },
            { name: "KEYR", addressOffset: "0x04", size: 32, access: "write-only", fields: [] },
            { name: "OPTKEYR", addressOffset: "0x08", size: 32, access: "write-only", fields: [] },
            {
                name: "SR",
                addressOffset: "0x0C",
                size: 32,
                access: "read-write",
                fields: [one("BSY", 0), one("PGERR", 2), one("WRPRTERR", 4), one("EOP", 5)],
            },
            {
                name: "CR",
                addressOffset: "0x10",
                size: 32,
                access: "read-write",
                fields: [one("PG", 0), one("PER", 1), one("MER", 2), one("OPTPG", 4), one("OPTER", 5), one("STRT", 6), one("LOCK", 7), one("OPTWRE", 9), one("ERRIE", 10), one("EOPIE", 12)],
            },
            { name: "AR", addressOffset: "0x14", size: 32, access: "write-only", fields: [] },
            { name: "OBR", addressOffset: "0x1C", size: 32, access: "read-only", fields: [] },
            { name: "WRPR", addressOffset: "0x20", size: 32, access: "read-only", fields: [] },
        ],
    };
}

/** USART1（RM0008 §27.6）：SR/DR/BRR/CR1/CR2/CR3/GTPR。 */
function usart1Peripheral() {
    return {
        name: "USART1",
        baseAddress: "0x40013800",
        registers: [
            {
                name: "SR",
                addressOffset: "0x00",
                size: 32,
                access: "read-write",
                fields: [one("PE", 0), one("FE", 1), one("NE", 2), one("ORE", 3), one("IDLE", 4), one("RXNE", 5), one("TC", 6), one("TXE", 7), one("LBD", 8), one("CTS", 9)],
            },
            { name: "DR", addressOffset: "0x04", size: 32, access: "read-write", fields: [many("DR", 0, 9)] },
            {
                name: "BRR",
                addressOffset: "0x08",
                size: 32,
                access: "read-write",
                fields: [many("DIV_Fraction", 0, 4), many("DIV_Mantissa", 4, 12)],
            },
            {
                name: "CR1",
                addressOffset: "0x0C",
                size: 32,
                access: "read-write",
                fields: [one("SBK", 0), one("RWU", 1), one("RE", 2), one("TE", 3), one("IDLEIE", 4), one("RXNEIE", 5), one("TCIE", 6), one("TXEIE", 7), one("PEIE", 8), one("PS", 9), one("PCE", 10), one("WAKE", 11), one("M", 12), one("UE", 13)],
            },
            {
                name: "CR2",
                addressOffset: "0x10",
                size: 32,
                access: "read-write",
                fields: [many("ADD", 0, 4), one("LBDL", 5), one("LBDIE", 6), one("LBCL", 8), one("CPHA", 9), one("CPOL", 10), many("CLKEN", 11, 1), one("STOP", 12), one("LINEN", 14)],
            },
            {
                name: "CR3",
                addressOffset: "0x14",
                size: 32,
                access: "read-write",
                fields: [one("EIE", 0), one("IREN", 1), one("IRLP", 2), one("HDSEL", 3), one("NACK", 4), one("SCEN", 5), one("DMAR", 6), one("DMAT", 7), one("RTSE", 8), one("CTSE", 9), one("CTSIE", 10)],
            },
            { name: "GTPR", addressOffset: "0x18", size: 32, access: "read-write", fields: [many("PSC", 0, 8), many("GT", 8, 8)] },
        ],
    };
}

/** TIM2（RM0008 §15.4）：只抄常用寄存器；CCMR1/CCMR2 的位域组合太碎，留空不当位域表用。 */
function tim2Peripheral() {
    return {
        name: "TIM2",
        baseAddress: "0x40000000",
        registers: [
            {
                name: "CR1",
                addressOffset: "0x00",
                size: 32,
                access: "read-write",
                fields: [one("CEN", 0), one("UDIS", 1), one("URS", 2), one("OPM", 3), one("DIR", 4), many("CMS", 5, 2), one("ARPE", 7), one("CKD", 8), one("ARPE", 7)],
            },
            { name: "CR2", addressOffset: "0x04", size: 32, access: "read-write", fields: [many("CCDS", 3, 1), many("MMS", 4, 3), one("TI1S", 7)] },
            {
                name: "SMCR",
                addressOffset: "0x08",
                size: 32,
                access: "read-write",
                fields: [many("SMS", 0, 3), many("TS", 4, 3), one("MSM", 7), many("ETF", 8, 4), many("ETPS", 12, 2), one("ECE", 14), one("ETP", 15)],
            },
            {
                name: "DIER",
                addressOffset: "0x0C",
                size: 32,
                access: "read-write",
                fields: [one("UIE", 0), one("CC1IE", 1), one("CC2IE", 2), one("CC3IE", 3), one("CC4IE", 4), one("COMIE", 5), one("TIE", 6), one("BIE", 7), one("UDE", 8), one("CC1DE", 9), one("CC2DE", 10), one("CC3DE", 11), one("CC4DE", 12), one("COMDE", 13), one("TDE", 14)],
            },
            {
                name: "SR",
                addressOffset: "0x10",
                size: 32,
                access: "read-write",
                fields: [one("UIF", 0), one("CC1IF", 1), one("CC2IF", 2), one("CC3IF", 3), one("CC4IF", 4), one("COMIF", 5), one("TIF", 6), one("BIF", 7), one("CC1OF", 9), one("CC2OF", 10), one("CC3OF", 11), one("CC4OF", 12)],
            },
            {
                name: "EGR",
                addressOffset: "0x14",
                size: 32,
                access: "write-only",
                fields: [one("UG", 0), one("CC1G", 1), one("CC2G", 2), one("CC3G", 3), one("CC4G", 4), one("COMG", 5), one("TG", 6), one("BG", 7)],
            },
            { name: "CCMR1", addressOffset: "0x18", size: 32, access: "read-write", fields: [] },
            { name: "CCMR2", addressOffset: "0x1C", size: 32, access: "read-write", fields: [] },
            {
                name: "CCER",
                addressOffset: "0x20",
                size: 32,
                access: "read-write",
                fields: [one("CC1E", 0), one("CC1P", 1), one("CC2E", 4), one("CC2P", 5), one("CC3E", 8), one("CC3P", 9), one("CC4E", 12), one("CC4P", 13)],
            },
            { name: "CNT", addressOffset: "0x24", size: 32, access: "read-write", fields: [many("CNT", 0, 16)] },
            { name: "PSC", addressOffset: "0x28", size: 32, access: "read-write", fields: [many("PSC", 0, 16)] },
            { name: "ARR", addressOffset: "0x2C", size: 32, access: "read-write", fields: [many("ARR", 0, 16)] },
            { name: "CCR1", addressOffset: "0x34", size: 32, access: "read-write", fields: [many("CCR1", 0, 16)] },
            { name: "CCR2", addressOffset: "0x38", size: 32, access: "read-write", fields: [many("CCR2", 0, 16)] },
            { name: "CCR3", addressOffset: "0x3C", size: 32, access: "read-write", fields: [many("CCR3", 0, 16)] },
            { name: "CCR4", addressOffset: "0x40", size: 32, access: "read-write", fields: [many("CCR4", 0, 16)] },
            { name: "DCR", addressOffset: "0x48", size: 32, access: "read-write", fields: [many("DBA", 0, 5), many("DBL", 8, 5)] },
            { name: "DMAR", addressOffset: "0x4C", size: 32, access: "read-write", fields: [many("DMAB", 0, 16)] },
        ],
    };
}

/**
 * 手写子集的外设表。返回的是「已解析好」的形态（baseAddress 与 addressOffset 都是
 * 0x 大写十六进制字符串），和 scripts/svd-f1.mjs 的 sanitizePeripheral 输出同构。
 */
export function handwrittenPeripherals() {
    const peripherals = [
        { name: "GPIOA", baseAddress: "0x40010800", registers: gpioRegisters() },
        { name: "GPIOB", baseAddress: "0x40010C00", registers: gpioRegisters() },
        { name: "GPIOC", baseAddress: "0x40011000", registers: gpioRegisters() },
        { name: "GPIOD", baseAddress: "0x40011400", registers: gpioRegisters() },
        { name: "GPIOE", baseAddress: "0x40011800", registers: gpioRegisters() },
        rccPeripheral(),
        flashPeripheral(),
        usart1Peripheral(),
        tim2Peripheral(),
    ];
    return peripherals;
}

/** 手写兜底时 source 里的定位信息：没有上游 URL，只有手册章节。 */
export const HANDWRITTEN_SOURCE = {
    kind: "handwritten",
    document: "RM0008 Rev 20（STM32F10xxx 参考手册）",
    sections: "GPIO §9.2、RCC §8.3、FLASH §3.3.3、USART §27.6、TIM §15.4",
    note: "脚本拿不到 ST 官方 STM32F103xx.svd 时退回的手写子集，不是完整 SVD",
};
